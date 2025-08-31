# main.py
import functions_framework
from google.cloud import storage
from google import genai
from google.genai import types
import json
import os
import re
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

# --- REMOVED ---
# The concept of a fixed MAX_CHUNK_SIZE and OVERLAP_SIZE is being replaced
# by a more intelligent, semantic chunking strategy.
# MAX_CHUNK_SIZE = 1500
# OVERLAP_SIZE = 200

# Define structured output schemas using Pydantic models
class DocumentType(enum.Enum):
    LECTURE_NOTES = "lecture_notes"
    PROBLEM_SET = "problem_set"
    EXAM = "exam"
    TEXTBOOK_CHAPTER = "textbook_chapter"
    HOMEWORK = "homework"
    QUIZ = "quiz"
    REFERENCE_MATERIAL = "reference_material"
    UNKNOWN = "unknown"

class DocumentMetadata(BaseModel):
    subject: str
    institution: Optional[str] = None
    department: Optional[str] = None
    course_code: Optional[str] = None
    document_type: DocumentType

class ChunkData(BaseModel):
    chunk_id: int
    text: str
    summary: str
    start_pos: int
    embedding: Optional[List[float]] = None

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

    def extract_basic_metadata(self, content: str, filename: str) -> Dict[str, Any]:
        prompt = f"""
        Analyze this academic document and extract basic metadata. Be specific and accurate.
        
        Document filename: {filename}
        Document content: {content[:2000]}...
        
        Extract:
        - subject: Main academic subject (be specific, e.g., "linear_algebra" not just "math")
        - institution: University name if clearly identifiable, otherwise null
        - department: Department/faculty if identifiable, otherwise null  
        - course_code: Course code if identifiable, otherwise null
        - document_type: Type of academic document
        """
        try:
            response = self.client.models.generate_content(
                model=FAST_MODEL,
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    # max_output_tokens=500, # This is fine for metadata, can leave or remove
                    response_mime_type="application/json",
                    response_schema=DocumentMetadata
                )
            )
            metadata_obj: DocumentMetadata = response.parsed
            if not metadata_obj:
                raise ValueError("Model failed to produce structured output for metadata.")
            metadata = {
                "subject": metadata_obj.subject,
                "institution": metadata_obj.institution,
                "department": metadata_obj.department,
                "course_code": metadata_obj.course_code,
                "document_type": metadata_obj.document_type.value
            }
            print(f"✅ Extracted metadata: {metadata}")
            return metadata
        except Exception as e:
            logger.error(f"❌ Error extracting metadata: {e}")
            return {
                "subject": "unknown",
                "institution": None,
                "department": None,
                "course_code": None,
                "document_type": "unknown"
            }

    def transcribe_document(self, file_data: bytes, mime_type: str) -> str:
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
        try:
            import base64
            encoded_content = base64.b64encode(file_data).decode('utf-8')
            content_parts = [
                {"inline_data": {"mime_type": mime_type, "data": encoded_content}},
                {"text": transcription_prompt}
            ]
            response = self.client.models.generate_content(
                model=SMART_MODEL,
                contents=content_parts,
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    # --- CHANGED ---: Removed max_output_tokens to allow for full document transcription
                    # max_output_tokens=8192
                )
            )
            transcribed_text = response.text.strip()
            print(f"✅ Transcription completed. Length: {len(transcribed_text)} characters")
            return transcribed_text
        except Exception as e:
            logger.error(f"❌ Error during transcription: {e}")
            return ""

    def create_meaningful_chunks(self, text: str, metadata: Dict[str, Any]) -> List[Dict[str, Any]]:
        # --- NEW: Overhauled chunking prompt for semantic completeness ---
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
        try:
            response = self.client.models.generate_content(
                model=SMART_MODEL,
                contents=chunking_prompt,
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    # --- CHANGED ---: Removed max_output_tokens to allow for a large number of long chunks
                    # max_output_tokens=8192,
                    response_mime_type="application/json",
                    response_schema=list[ChunkData]
                )
            )
            chunks_data: list[ChunkData] = response.parsed
            if not chunks_data:
                logger.warning("⚠️ Model did not return valid structured data for chunks.")
                print("Falling back to simple, paragraph-based chunking.")
                return self._simple_chunk_fallback(text, metadata)

            enhanced_chunks = []
            for chunk in chunks_data:
                enhanced_chunk = {
                    "chunk_id": chunk.chunk_id,
                    "text": chunk.text,
                    "summary": chunk.summary,
                    "start_pos": chunk.start_pos,
                    **metadata,
                    "chunk_length": len(chunk.text),
                    "embedding": chunk.embedding
                }
                enhanced_chunks.append(enhanced_chunk)
            print(f"✅ Created {len(enhanced_chunks)} meaningful, topic-centric chunks")
            return enhanced_chunks
        except Exception as e:
            logger.error(f"❌ An unexpected error occurred during chunk creation: {e}")
            print("Falling back to simple, paragraph-based chunking due to an unexpected error.")
            return self._simple_chunk_fallback(text, metadata)

    def _simple_chunk_fallback(self, text: str, metadata: Dict[str, Any]) -> List[Dict[str, Any]]:
        # --- CHANGED: Improved fallback method to be more logical ---
        """
        Fallback chunking method. Splits by paragraphs, which is more coherent
        than a fixed character count.
        """
        chunks = []
        # Split by two or more newlines, which typically signifies a paragraph break
        paragraphs = re.split(r'\n{2,}', text)
        current_pos = 0
        for i, para_text in enumerate(paragraphs):
            if not para_text.strip():
                current_pos += len(para_text) + 2 # Account for newlines
                continue

            chunk = {
                "chunk_id": i + 1,
                "text": para_text.strip(),
                "summary": f"Content from paragraph {i + 1}",
                "start_pos": text.find(para_text, current_pos),
                **metadata,
                "chunk_length": len(para_text.strip()),
                "embedding": None
            }
            chunks.append(chunk)
            current_pos = chunk["start_pos"] + chunk["chunk_length"]

        print(f"✅ Created {len(chunks)} chunks using paragraph-based fallback.")
        return chunks

    def generate_embeddings(self, chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        print(f"🧠 Generating embeddings for {len(chunks)} chunks...")
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
        print(f"✅ Generated {successful_embeddings}/{len(chunks)} embeddings")
        return chunks

    def process_document(self, bucket_name: str, file_name: str) -> Dict[str, Any]:
        print(f"🚀 Starting processing for {file_name}")
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

            transcribed_text = self.transcribe_document(file_data, mime_type)
            if not transcribed_text:
                raise ValueError("Transcription failed")

            metadata = self.extract_basic_metadata(transcribed_text, file_name)
            metadata["original_file"] = file_name
            metadata["mime_type"] = mime_type
            metadata["file_size"] = len(file_data)
            metadata["transcription_length"] = len(transcribed_text)

            chunks = self.create_meaningful_chunks(transcribed_text, metadata)
            chunks_with_embeddings = self.generate_embeddings(chunks)

            result = {
                "status": "success",
                "metadata": metadata,
                "transcribed_text": transcribed_text,
                "chunks": chunks_with_embeddings,
                "total_chunks": len(chunks_with_embeddings),
                "processing_summary": {
                    "file_processed": file_name,
                    "chunks_created": len(chunks_with_embeddings),
                    "embeddings_generated": sum(1 for c in chunks_with_embeddings if c.get("embedding")),
                    "transcription_length": len(transcribed_text)
                }
            }
            print(f"✅ Processing completed successfully for {file_name}")
            return result
        except Exception as e:
            logger.error(f"❌ Processing failed for {file_name}: {e}")
            return {"status": "error", "error": str(e), "file": file_name}

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

        WEBHOOK_URL = os.environ.get("BACKEND_WEBHOOK_URL", "http://localhost:5000/api/gcs-webhook")
        WEBHOOK_SECRET_TOKEN = os.environ.get("WEBHOOK_SECRET_TOKEN", "REMOVED_EXPOSED_RETIRED_GCS_TOKEN")

        if result["status"] == "success":
            try:
                headers = {
                    "Content-Type": "application/json",
                    "X-Webhook-Secret": WEBHOOK_SECRET_TOKEN
                }
                print(f"Attempting to send data to webhook URL: {WEBHOOK_URL}")
                response = requests.post(WEBHOOK_URL, json=result, headers=headers, timeout=60)
                response.raise_for_status()
                print(f"✅ Data successfully sent to backend. Status: {response.status_code}")
            except requests.exceptions.Timeout:
                logger.error("❌ Request to backend timed out.")
            except requests.exceptions.RequestException as e:
                logger.error(f"❌ Error sending data to backend: {e}")
                logger.error(f"Failed result data (first 500 chars): {json.dumps(result, indent=2)[:500]}...")
        else:
            print(f"🚫 Document processing failed, not sending to backend.")

        print("🎉 Function completed successfully")
        return result
    except Exception as e:
        logger.error(f"💥 Function failed: {e}")
        return {"status": "error", "error": str(e)}