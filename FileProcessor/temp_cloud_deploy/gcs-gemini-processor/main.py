# main.py, runs as a Google Cloud Function triggered by GCS file uploads.
import functions_framework
from google.cloud import storage
from google import genai
from google.genai import types
import json
import os
import re
import time
from typing import List, Dict, Any, Optional, Literal
import logging
import enum
from pydantic import BaseModel
import requests

# Configure logging for errors, but we will use print() for info messages for visibility in Cloud Run
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

# --- Configuration ---
GCP_PROJECT_ID = "hwai-agent-470618"
GCP_REGION = "us-central1"

# Model configuration for tiered processing
FAST_MODEL = "gemini-2.5-flash"  # For basic classification tasks
SMART_MODEL = "gemini-2.5-pro"   # For complex analysis tasks
EMBEDDING_MODEL = "gemini-embedding-001"

# --- MODIFIED: Define structured output schemas using Pydantic models ---
class DocumentType(enum.Enum):
    LECTURE_NOTES = "lecture_notes"
    PROBLEM_SET = "problem_set"
    EXAM = "exam"
    TEXTBOOK_CHAPTER = "textbook_chapter"
    HOMEWORK = "homework"
    QUIZ = "quiz"
    REFERENCE_MATERIAL = "reference_material"
    UNKNOWN = "unknown"

# --- MODIFIED: Schema is now simpler, only for document_type ---
class DocumentMetadata(BaseModel):
    document_type: DocumentType

class ChunkData(BaseModel):
    chunk_id: int
    text: str
    summary: str
    start_pos: int
    embedding: Optional[List[float]] = None

# --- NEW: Performance tracking data structure ---
class PerformanceMetrics:
    def __init__(self):
        self.transcribed_characters = 0
        self.transcription_tokens = 0
        self.transcription_time = 0
        self.transcription_success = False
        self.chunks_count = 0
        self.total_chunk_characters = 0
        self.chunking_tokens = 0
        self.chunking_time = 0
        self.chunking_success = False
        self.total_time = 0  # NEW: Track total processing time

class AcademicDocumentProcessor:
    def __init__(self):
        self.storage_client = storage.Client()
        try:
            self.client = genai.Client(
                vertexai=True,
                project=GCP_PROJECT_ID,
                location=GCP_REGION
            )
            print(f"✅ Gemini client initialized successfully for Vertex AI in project '{GCP_PROJECT_ID}' and location '{GCP_REGION}'")
        except Exception as e:
            logger.error(f"❌ Failed to initialize Gemini client for Vertex AI: {e}")
            raise

    # --- NEW: Send incremental webhook updates ---
    def send_webhook_update(self, file_name: str, update_type: str, data: Dict[str, Any]):
        """Send incremental updates to the webhook"""
        WEBHOOK_URL = os.environ.get("BACKEND_WEBHOOK_URL", "http://localhost:5000/api/gcs-webhook")
        WEBHOOK_SECRET_TOKEN = os.environ.get("WEBHOOK_SECRET_TOKEN", "REMOVED_EXPOSED_RETIRED_GCS_TOKEN")
        
        payload = {
            "update_type": update_type,
            "file_name": file_name,
            "data": data
        }
        
        try:
            headers = {
                "Content-Type": "application/json",
                "X-Webhook-Secret": WEBHOOK_SECRET_TOKEN
            }
            print(f"📤 Sending {update_type} update to webhook for {file_name}")
            response = requests.post(WEBHOOK_URL, json=payload, headers=headers, timeout=30)
            response.raise_for_status()
            print(f"✅ {update_type} update sent successfully. Status: {response.status_code}")
        except requests.exceptions.Timeout:
            logger.error(f"❌ {update_type} webhook update timed out for {file_name}")
        except requests.exceptions.RequestException as e:
            logger.error(f"❌ Error sending {update_type} webhook update for {file_name}: {e}")

    # --- MODIFIED: Simplified to extract only document_type ---
    def extract_document_type(self, content: str, filename: str) -> Dict[str, Any]:
        prompt = f"""
        Analyze the academic document to determine its type.
        
        Document filename: {filename}
        Document content (first 5000 chars): {content[:5000]}...
        
        Classify the document into one of the following types:
        - lecture_notes
        - problem_set
        - exam
        - textbook_chapter
        - homework
        - quiz
        - reference_material
        - unknown
        """
        try:
            response = self.client.models.generate_content(
                model=FAST_MODEL,
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    response_mime_type="application/json",
                    response_schema=DocumentMetadata
                )
            )
            metadata_obj: DocumentMetadata = response.parsed
            if not metadata_obj:
                raise ValueError("Model failed to produce structured output for metadata.")
            
            metadata = { "document_type": metadata_obj.document_type.value }
            print(f"✅ Extracted metadata: {metadata}")
            return metadata
        except Exception as e:
            logger.error(f"❌ Error extracting metadata: {e}")
            return { "document_type": "unknown" }

    # --- MODIFIED: Added performance tracking and webhook update ---
    def transcribe_document(self, file_data: bytes, mime_type: str, file_name: str, metrics: PerformanceMetrics) -> str:
        transcription_prompt = """
        Transcribe this document into clean, complete, and accurate Markdown format. Follow these rules:
        
        1. Use proper Markdown formatting (headers, lists, bold, italic).
        2. For mathematical formulas, use LaTeX syntax (e.g., $E=mc^2$ for inline, $$...$$ for block).
        3. For figures/charts/plots, describe them in detail within blockquotes (> Description...).
        4. Preserve the logical structure and hierarchy perfectly.
        5. **Crucially, ensure the entire document is transcribed. Do not truncate or omit any part.**
        6. Use appropriate heading levels (# ## ### etc.) to reflect the document's structure.
        
        Output only the transcribed content, with no additional commentary.
        """
        
        start_time = time.time()
        
        try:
            import base64
            encoded_content = base64.b64encode(file_data).decode('utf-8')
            content_parts = [
                {"inline_data": {"mime_type": mime_type, "data": encoded_content}},
                {"text": transcription_prompt}
            ]
            
            # Count tokens before processing
            try:
                token_count_result = self.client.models.count_tokens(
                    model=SMART_MODEL,
                    contents=content_parts
                )
                print(f"📊 Transcription input tokens: {token_count_result.total_tokens}")
            except Exception as e:
                logger.warning(f"⚠️ Could not count transcription input tokens: {e}")
                token_count_result = None
            
            response = self.client.models.generate_content(
                model=SMART_MODEL,
                contents=content_parts,
                config=types.GenerateContentConfig(
                    temperature=0.1,
                )
            )
            if response.prompt_feedback:
                logger.error(f"Prompt feedback: block_reason={response.prompt_feedback.block_reason}, "
                            f"safety_ratings={response.prompt_feedback.safety_ratings}")
    
            if not response.candidates:
                logger.error("No candidates in response. Possible safety block or empty generation.")
                raise ValueError("Generation failed: No candidates returned.")
    
            for candidate in response.candidates:
                logger.info(f"Candidate finish_reason: {candidate.finish_reason}")
                if candidate.finish_reason == types.FinishReason.SAFETY:
                    logger.error(f"Safety block detected. Ratings: {candidate.safety_ratings}")
                elif candidate.finish_reason == types.FinishReason.RECITATION:
                    logger.error("Recitation detected - output too similar to source material.")
    
            # Only proceed if text is available
            if not response.text:
                raise ValueError("No text generated in response. See logs for details.")
            transcribed_text = response.text.strip()
            end_time = time.time()
            
            # Update metrics
            metrics.transcribed_characters = len(transcribed_text)
            metrics.transcription_time = round(end_time - start_time)
            metrics.transcription_success = True
            
            # Get token usage from response
            if hasattr(response, 'usage_metadata') and response.usage_metadata:
                metrics.transcription_tokens = response.usage_metadata.total_token_count
                print(f"📊 Transcription total tokens used: {metrics.transcription_tokens}")
            elif token_count_result:
                # Fallback to input token count if usage_metadata not available
                metrics.transcription_tokens = token_count_result.total_tokens
                print(f"📊 Transcription tokens (input only): {metrics.transcription_tokens}")
            else:
                metrics.transcription_tokens = 0
                print("⚠️ Could not determine transcription token usage")
            
            print(f"✅ Transcription completed. Length: {len(transcribed_text)} characters, Time: {metrics.transcription_time}s")
            
            # --- NEW: Send transcription webhook update ---
            transcription_data = {
                "transcribed_text": transcribed_text,
                "transcribed_characters": metrics.transcribed_characters,
                "transcription_tokens": metrics.transcription_tokens,
                "transcription_time": metrics.transcription_time,
                "transcription_success": metrics.transcription_success
            }
            self.send_webhook_update(file_name, "transcription_complete", transcription_data)
            
            return transcribed_text
            
        except Exception as e:
            end_time = time.time()
            metrics.transcription_time = round(end_time - start_time)
            metrics.transcription_success = False
            logger.error(f"❌ Error during transcription: {e}")
            
            # --- NEW: Send transcription error webhook update ---
            error_data = {
                "transcription_time": metrics.transcription_time,
                "transcription_success": False,
                "error": str(e)
            }
            self.send_webhook_update(file_name, "transcription_error", error_data)
            
            return ""

    # --- MODIFIED: Added performance tracking and webhook update ---
    def create_meaningful_chunks(self, text: str, file_name: str, metrics: PerformanceMetrics) -> List[Dict[str, Any]]:
        chunking_prompt = f"""
        You are an expert academic assistant tasked with dividing a transcribed document into high-quality, semantically complete chunks for a Retrieval-Augmented Generation (RAG) system.

        **Primary Directive:** The coherence and conceptual completeness of a chunk are the top priority. Do NOT break chunks based on length. A chunk must contain a full, self-contained topic.

        **Chunking Rules:**
        1.  **Topic-Centric:** A new chunk should only start when a new, distinct topic begins.
        2.  **Completeness over Length:** Keep related concepts together, no matter how long the resulting chunk is.
            -   **Example Rule:** If you see a problem set question with parts (a), (b), and (c), the entire question AND its full solution must be contained within a SINGLE chunk. Do not split them.
            -   **Example Rule:** If a section defines a theorem and then provides a multi-page proof and example, the definition, proof, and example should ideally be in ONE chunk.
        3.  **Logical Breakpoints:** Good places to create a new chunk are at the start of a major new section (e.g., a new `## Section Title`), a completely new example problem, or a significant shift in the subject matter. Avoid breaking in the middle of a paragraph, list, or explanation.
        4.  **No Overlap Needed:** Do not create artificial overlap between chunks. The contextual completeness of each chunk makes it unnecessary.
        5.  **Summarize Clearly:** For each chunk, provide a concise summary that captures its core topic or question.

        **Text to Chunk:**
        ---
        {text}
        ---
        """
        
        start_time = time.time()
        
        try:
            # Count tokens before processing
            try:
                token_count_result = self.client.models.count_tokens(
                    model=SMART_MODEL,
                    contents=chunking_prompt
                )
                print(f"📊 Chunking input tokens: {token_count_result.total_tokens}")
            except Exception as e:
                logger.warning(f"⚠️ Could not count chunking input tokens: {e}")
                token_count_result = None
            
            response = self.client.models.generate_content(
                model=SMART_MODEL,
                contents=chunking_prompt,
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    response_mime_type="application/json",
                    response_schema=list[ChunkData]
                )
            )
            
            chunks_data: list[ChunkData] = response.parsed
            end_time = time.time()
            
            if not chunks_data:
                logger.warning("⚠️ Model did not return valid structured data for chunks.")
                print("Falling back to simple, paragraph-based chunking.")
                fallback_chunks = self._simple_chunk_fallback(text)
                
                # Update metrics for fallback
                metrics.chunks_count = len(fallback_chunks)
                metrics.total_chunk_characters = sum(chunk["chunk_length"] for chunk in fallback_chunks)
                metrics.chunking_time = round(end_time - start_time)
                metrics.chunking_success = False
                metrics.chunking_tokens = 0
                
                # --- NEW: Send chunking webhook update for fallback ---
                chunking_data = {
                    "chunks_count": metrics.chunks_count,
                    "total_chunk_characters": metrics.total_chunk_characters,
                    "chunking_tokens": metrics.chunking_tokens,
                    "chunking_time": metrics.chunking_time,
                    "chunking_success": metrics.chunking_success,
                    "fallback_used": True
                }
                self.send_webhook_update(file_name, "chunking_complete", chunking_data)
                
                return fallback_chunks

            enhanced_chunks = []
            total_chars = 0
            for chunk in chunks_data:
                enhanced_chunk = {
                    "chunk_id": chunk.chunk_id,
                    "text": chunk.text,
                    "summary": chunk.summary,
                    "start_pos": chunk.start_pos,
                    "chunk_length": len(chunk.text),
                    "embedding": chunk.embedding
                }
                enhanced_chunks.append(enhanced_chunk)
                total_chars += len(chunk.text)
            
            # Update metrics
            metrics.chunks_count = len(enhanced_chunks)
            metrics.total_chunk_characters = total_chars
            metrics.chunking_time = round(end_time - start_time)
            metrics.chunking_success = True
            
            # Get token usage from response
            if hasattr(response, 'usage_metadata') and response.usage_metadata:
                metrics.chunking_tokens = response.usage_metadata.total_token_count
                print(f"📊 Chunking total tokens used: {metrics.chunking_tokens}")
            elif token_count_result:
                # Fallback to input token count if usage_metadata not available
                metrics.chunking_tokens = token_count_result.total_tokens
                print(f"📊 Chunking tokens (input only): {metrics.chunking_tokens}")
            else:
                metrics.chunking_tokens = 0
                print("⚠️ Could not determine chunking token usage")
            
            print(f"✅ Created {len(enhanced_chunks)} meaningful, topic-centric chunks. Time: {metrics.chunking_time}s, Total chars: {total_chars}")
            
            # --- NEW: Send chunking webhook update ---
            chunking_data = {
                "chunks_count": metrics.chunks_count,
                "total_chunk_characters": metrics.total_chunk_characters,
                "chunking_tokens": metrics.chunking_tokens,
                "chunking_time": metrics.chunking_time,
                "chunking_success": metrics.chunking_success,
                "fallback_used": False
            }
            self.send_webhook_update(file_name, "chunking_complete", chunking_data)
            
            return enhanced_chunks
            
        except Exception as e:
            end_time = time.time()
            metrics.chunking_time = round(end_time - start_time)
            metrics.chunking_success = False
            metrics.chunking_tokens = 0
            logger.error(f"❌ An unexpected error occurred during chunk creation: {e}")
            print("Falling back to simple, paragraph-based chunking due to an unexpected error.")
            
            fallback_chunks = self._simple_chunk_fallback(text)
            metrics.chunks_count = len(fallback_chunks)
            metrics.total_chunk_characters = sum(chunk["chunk_length"] for chunk in fallback_chunks)
            
            # --- NEW: Send chunking error webhook update ---
            error_data = {
                "chunks_count": metrics.chunks_count,
                "total_chunk_characters": metrics.total_chunk_characters,
                "chunking_tokens": 0,
                "chunking_time": metrics.chunking_time,
                "chunking_success": False,
                "fallback_used": True,
                "error": str(e)
            }
            self.send_webhook_update(file_name, "chunking_error", error_data)
            
            return fallback_chunks
    
    # --- MODIFIED: Removed metadata from fallback as it's no longer used here ---
    def _simple_chunk_fallback(self, text: str) -> List[Dict[str, Any]]:
        """
        Fallback chunking method. Splits by paragraphs, which is more coherent
        than a fixed character count.
        """
        chunks = []
        paragraphs = re.split(r'\n{2,}', text)
        current_pos = 0
        for i, para_text in enumerate(paragraphs):
            if not para_text.strip():
                current_pos += len(para_text) + 2 
                continue

            chunk = {
                "chunk_id": i + 1,
                "text": para_text.strip(),
                "summary": f"Content from paragraph {i + 1}",
                "start_pos": text.find(para_text, current_pos),
                "chunk_length": len(para_text.strip()),
                "embedding": None
            }
            chunks.append(chunk)
            current_pos = chunk["start_pos"] + chunk["chunk_length"]

        print(f"✅ Created {len(chunks)} chunks using paragraph-based fallback.")
        return chunks

    # --- MODIFIED: Added webhook update for embeddings ---
    def generate_embeddings(self, chunks: List[Dict[str, Any]], file_name: str) -> List[Dict[str, Any]]:
        print(f"🧠 Generating embeddings for {len(chunks)} chunks...")
        start_time = time.time()
        
        for chunk in chunks:
            try:
                result = self.client.models.embed_content(
                    model=EMBEDDING_MODEL,
                    contents=chunk["text"],
                    config=types.EmbedContentConfig(output_dimensionality=768)
                )
                embedding_obj = result.embeddings[0]
                chunk["embedding"] = embedding_obj.values
                chunk["embedding_length"] = len(embedding_obj.values)
            except Exception as e:
                logger.error(f"❌ Error generating embedding for chunk {chunk['chunk_id']}: {e}")
                chunk["embedding"] = None
                chunk["embedding_length"] = 0
        
        successful_embeddings = sum(1 for chunk in chunks if chunk["embedding"] is not None)
        embedding_time = round(time.time() - start_time)
        
        print(f"✅ Generated {successful_embeddings}/{len(chunks)} embeddings in {embedding_time}s")
        
        # --- NEW: Send embeddings webhook update ---
        embedding_data = {
            "embedding_time": embedding_time,
            "successful_embeddings": successful_embeddings,
            "total_chunks": len(chunks),
            "chunks_with_embeddings": chunks
        }
        self.send_webhook_update(file_name, "embeddings_complete", embedding_data)
        
        return chunks

    # --- MODIFIED: Added total time tracking and final webhook update ---
    def process_document(self, bucket_name: str, file_name: str) -> Dict[str, Any]:
        print(f"🚀 Starting processing for {file_name}")
        total_start_time = time.time()
        metrics = PerformanceMetrics()
        
        try:
            bucket = self.storage_client.bucket(bucket_name)
            blob = bucket.blob(file_name)
            blob.reload()
            mime_type = blob.content_type
            if not mime_type:
                raise ValueError("Could not determine MIME type")
            supported_types = [
                'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
                'application/pdf', 'text/plain', 'text/html', 'text/css',
                'text/javascript', 'text/markdown', 'text/csv',
                'application/json', 'text/xml', 'application/rtf'
            ]
            if mime_type not in supported_types:
                raise ValueError(f"Unsupported MIME type: {mime_type}")

            file_data = blob.download_as_bytes()
            print(f"📥 Downloaded {len(file_data)} bytes")

            transcribed_text = self.transcribe_document(file_data, mime_type, file_name, metrics)
            if not transcribed_text:
                raise ValueError("Transcription failed")

            # Extract document type
            llm_metadata = self.extract_document_type(transcribed_text, file_name)
            
            # Send document type webhook update
            metadata_data = {
                "document_type": llm_metadata["document_type"],
                "mime_type": mime_type,
                "file_size": len(file_data),
                "transcription_length": len(transcribed_text)
            }
            self.send_webhook_update(file_name, "metadata_extracted", metadata_data)

            chunks = self.create_meaningful_chunks(transcribed_text, file_name, metrics)
            chunks_with_embeddings = self.generate_embeddings(chunks, file_name)

            # Calculate total time
            total_end_time = time.time()
            metrics.total_time = round(total_end_time - total_start_time)

            # Create final performance metrics dictionary
            performance_metrics = {
                "transcribed_characters": metrics.transcribed_characters,
                "transcription_tokens": metrics.transcription_tokens,
                "transcription_time": metrics.transcription_time,
                "transcription_success": metrics.transcription_success,
                "chunks_count": metrics.chunks_count,
                "total_chunk_characters": metrics.total_chunk_characters,
                "chunking_tokens": metrics.chunking_tokens,
                "chunking_time": metrics.chunking_time,
                "chunking_success": metrics.chunking_success,
                "total_time": metrics.total_time  # NEW
            }

            metadata = {
                "original_file": file_name,
                "document_type": llm_metadata["document_type"],
                "mime_type": mime_type,
                "file_size": len(file_data),
                "transcription_length": len(transcribed_text)
            }

            result = {
                "status": "success",
                "metadata": metadata,
                "transcribed_text": transcribed_text,
                "chunks": chunks_with_embeddings,
                "performance_metrics": performance_metrics
            }

            # --- NEW: Send final completion webhook update ---
            final_data = {
                "total_time": metrics.total_time,
                "final_performance_metrics": performance_metrics
            }
            self.send_webhook_update(file_name, "processing_complete", final_data)

            print(f"✅ Processing completed successfully for {file_name} in {metrics.total_time}s")
            return result
            
        except Exception as e:
            total_end_time = time.time()
            metrics.total_time = round(total_end_time - total_start_time)
            logger.error(f"❌ Processing failed for {file_name}: {e}")
            
            # --- NEW: Send error webhook update ---
            error_data = {
                "total_time": metrics.total_time,
                "error": str(e)
            }
            self.send_webhook_update(file_name, "processing_error", error_data)
            
            return {"status": "error", "error": str(e), "file": file_name, "total_time": metrics.total_time}

# Initialize processor
processor = AcademicDocumentProcessor()

@functions_framework.cloud_event
def process_file_upload(cloud_event):
    try:
        data = cloud_event.data
        bucket_name = data["bucket"]
        file_name = data["name"]
        print(f"🎯 Function triggered for: {file_name}")
        result = processor.process_document(bucket_name, file_name)

        # Note: Individual webhook updates are now sent throughout processing
        # The original final webhook call is removed as incremental updates replace it

        print("🎉 Function completed successfully")
        return result
    except Exception as e:
        logger.error(f"💥 Function failed: {e}")
        return {"status": "error", "error": str(e)}