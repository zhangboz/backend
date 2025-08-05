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

# Configure logging for errors, but we will use print() for info messages for visibility in Cloud Run
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

# --- Configuration ---
GCP_PROJECT_ID = "hwai-agent"
GCP_REGION = "us-central1"

# Model configuration for tiered processing
FAST_MODEL = "gemini-2.5-flash"  # For basic classification tasks
SMART_MODEL = "gemini-2.5-pro"   # For complex analysis tasks
EMBEDDING_MODEL = "gemini-embedding-001"

# Chunk configuration
MAX_CHUNK_SIZE = 1500  # characters
OVERLAP_SIZE = 200     # characters for context overlap

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
    subject: str  # e.g., "mathematics", "physics", "linear_algebra"
    institution: Optional[str] = None  # e.g., "UBC", "MIT"
    department: Optional[str] = None   # e.g., "STATISTICS", "PHYSICS"
    course_code: Optional[str] = None  # e.g., "MATH 300", "PHYS 101"
    document_type: DocumentType

class ChunkData(BaseModel):
    chunk_id: int
    text: str
    summary: str
    start_pos: int

class AcademicDocumentProcessor:
    def __init__(self):
        # Initialize clients
        self.storage_client = storage.Client()
        
        # Initialize Gemini client to use Vertex AI
        try:
            self.client = genai.Client(
                vertexai=True, 
                project=GCP_PROJECT_ID, 
                location=GCP_REGION
            )
            # --- MODIFICATION: Use print for visibility ---
            print(f"✅ Gemini client initialized successfully for Vertex AI in project '{GCP_PROJECT_ID}' and location '{GCP_REGION}'")
        except Exception as e:
            logger.error(f"❌ Failed to initialize Gemini client for Vertex AI: {e}")
            raise
        
    def extract_basic_metadata(self, content: str, filename: str) -> Dict[str, Any]:
        """
        Use fast model for basic classification (subjects, institution detection)
        Uses structured output for reliable JSON parsing
        """
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
                    max_output_tokens=500,
                    response_mime_type="application/json",
                    response_schema=DocumentMetadata
                )
            )
            
            # Use the parsed response directly
            metadata_obj: DocumentMetadata = response.parsed
            
            if not metadata_obj:
                 # Add logging for when the model fails to parse.
                logger.warning("⚠️ Model did not return valid structured data for metadata.")
                try:
                    logger.warning(f"Model raw output for metadata: {response.text}")
                except Exception:
                    pass # Ignore if text isn't available
                raise ValueError("Model failed to produce structured output for metadata.")

            # Convert to dict for backward compatibility
            metadata = {
                "subject": metadata_obj.subject,
                "institution": metadata_obj.institution,
                "department": metadata_obj.department,
                "course_code": metadata_obj.course_code,
                "document_type": metadata_obj.document_type.value
            }
            
            # --- MODIFICATION: Use print for visibility ---
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
        """
        Transcribe document content using the smart model
        """
        transcription_prompt = """
        Transcribe this document into clean Markdown format with the following rules:
        
        1. Use proper Markdown formatting (headers, lists, bold, italic)
        2. For mathematical formulas, use LaTeX syntax (e.g., $E=mc^2$ for inline, $$...$$ for block)
        3. For figures/charts/plots, describe them in detail within blockquotes (> Description...)
        4. Preserve the logical structure and hierarchy
        5. Do not miss any critical information
        6. Use appropriate heading levels (# ## ### etc.)
        
        Output only the transcribed content, no additional commentary.
        """
        
        try:
            # Encode file data for API
            import base64
            encoded_content = base64.b64encode(file_data).decode('utf-8')
            
            # Structure the content properly for the unified SDK
            content_parts = [
                {
                    "inline_data": {
                        "mime_type": mime_type,
                        "data": encoded_content
                    }
                },
                {"text": transcription_prompt}
            ]
            
            response = self.client.models.generate_content(
                model=SMART_MODEL,
                contents=content_parts,
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    max_output_tokens=8192
                )
            )
            
            transcribed_text = response.text.strip()
            # --- MODIFICATION: Use print for visibility ---
            print(f"✅ Transcription completed. Length: {len(transcribed_text)} characters")
            return transcribed_text
            
        except Exception as e:
            logger.error(f"❌ Error during transcription: {e}")
            return ""
    
    def create_meaningful_chunks(self, text: str, metadata: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Create meaningful chunks using smart model for better context understanding
        Uses structured output for reliable parsing
        """
        chunking_prompt = f"""
        Divide this academic text into meaningful, contextually complete chunks for a knowledge base.
        
        Requirements:
        1. Each chunk should be contextually complete (don't break mid-sentence or mid-concept)
        2. Maximum {MAX_CHUNK_SIZE} characters per chunk
        3. Group related concepts together
        4. Include slight overlap with adjacent chunks for context
        5. Provide a clear summary of each chunk's main topic
        
        Text to chunk:
        {text}
        """
        
        try:
            response = self.client.models.generate_content(
                model=SMART_MODEL,
                contents=chunking_prompt,
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    # --- MODIFICATION: Increase token limit to prevent truncated JSON ---
                    max_output_tokens=8192,
                    response_mime_type="application/json",
                    response_schema=list[ChunkData]
                )
            )
            
            # Use the parsed response directly
            chunks_data: list[ChunkData] = response.parsed
            
            if not chunks_data:
                logger.warning("⚠️ Model did not return valid structured data for chunks.")
                try:
                    # Log the raw text for debugging
                    raw_output = response.text
                    logger.warning(f"Model raw output that failed parsing: {raw_output[:1000]}...")
                except Exception:
                    logger.warning("Could not retrieve raw text from the failed model response.")
                
                print("Falling back to simple, non-AI chunking.")
                return self._simple_chunk_fallback(text, metadata)

            # Convert to enhanced format with metadata
            enhanced_chunks = []
            for i, chunk in enumerate(chunks_data):
                enhanced_chunk = {
                    "chunk_id": chunk.chunk_id,
                    "text": chunk.text,
                    "summary": chunk.summary,
                    "start_pos": chunk.start_pos,
                    **metadata,  # Inherit metadata from document
                    "chunk_length": len(chunk.text),
                    "embedding": None  # Will be filled later
                }
                enhanced_chunks.append(enhanced_chunk)
            
            # --- MODIFICATION: Use print for visibility ---
            print(f"✅ Created {len(enhanced_chunks)} meaningful chunks")
            return enhanced_chunks
            
        except Exception as e:
            logger.error(f"❌ An unexpected error occurred during chunk creation: {e}")
            print("Falling back to simple, non-AI chunking due to an unexpected error.")
            return self._simple_chunk_fallback(text, metadata)
    
    def _simple_chunk_fallback(self, text: str, metadata: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Fallback chunking method if AI chunking fails
        """
        chunks = []
        chunk_id = 1
        
        for i in range(0, len(text), MAX_CHUNK_SIZE - OVERLAP_SIZE):
            chunk_text = text[i:i + MAX_CHUNK_SIZE]
            
            chunk = {
                "chunk_id": chunk_id,
                "text": chunk_text,
                "summary": f"Content chunk {chunk_id}",
                "start_pos": i,
                **metadata,
                "chunk_length": len(chunk_text),
                "embedding": None
            }
            chunks.append(chunk)
            chunk_id += 1
        
        # --- MODIFICATION: Use print for visibility ---
        print(f"✅ Created {len(chunks)} chunks using simple fallback method.")
        return chunks
    
    def generate_embeddings(self, chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Generate embeddings for all chunks
        """
        # --- MODIFICATION: Use print for visibility ---
        print(f"🧠 Generating embeddings for {len(chunks)} chunks...")
        
        for chunk in chunks:
            try:
                # Use the new SDK for embeddings
                result = self.client.models.embed_content(
                    model=EMBEDDING_MODEL,
                    contents=chunk["text"],
                    config=types.EmbedContentConfig(output_dimensionality=768)
                )
                
                # Extract embedding values
                embedding_obj = result.embeddings[0]
                chunk["embedding"] = embedding_obj.values
                chunk["embedding_length"] = len(embedding_obj.values)
                
            except Exception as e:
                logger.error(f"❌ Error generating embedding for chunk {chunk['chunk_id']}: {e}")
                chunk["embedding"] = None
                chunk["embedding_length"] = 0
        
        successful_embeddings = sum(1 for chunk in chunks if chunk["embedding"] is not None)
        # --- MODIFICATION: Use print for visibility ---
        print(f"✅ Generated {successful_embeddings}/{len(chunks)} embeddings")
        
        return chunks

    def process_document(self, bucket_name: str, file_name: str) -> Dict[str, Any]:
        """
        Main processing pipeline
        """
        # --- MODIFICATION: Use print for visibility ---
        print(f"🚀 Starting processing for {file_name}")
        
        try:
            # Download file
            bucket = self.storage_client.bucket(bucket_name)
            blob = bucket.blob(file_name)
            blob.reload()
            
            mime_type = blob.content_type
            if not mime_type:
                raise ValueError("Could not determine MIME type")
            
            # Check supported formats
            supported_types = [
                'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
                'application/pdf', 'text/plain', 'text/html', 'text/css', 
                'text/javascript', 'text/markdown', 'text/csv',
                'application/json', 'text/xml', 'application/rtf'
            ]
            
            if mime_type not in supported_types:
                raise ValueError(f"Unsupported MIME type: {mime_type}")
            
            # Download file content
            file_data = blob.download_as_bytes()
            # --- MODIFICATION: Use print for visibility ---
            print(f"📥 Downloaded {len(file_data)} bytes")
            
            # Step 1: Transcribe document (Smart Model)
            transcribed_text = self.transcribe_document(file_data, mime_type)
            if not transcribed_text:
                raise ValueError("Transcription failed")
            
            # Step 2: Extract basic metadata (Fast Model)
            metadata = self.extract_basic_metadata(transcribed_text, file_name)
            metadata["original_file"] = file_name
            metadata["mime_type"] = mime_type
            metadata["file_size"] = len(file_data)
            metadata["transcription_length"] = len(transcribed_text)
            
            # Step 3: Create meaningful chunks (Smart Model)
            chunks = self.create_meaningful_chunks(transcribed_text, metadata)
            
            # Step 4: Generate embeddings
            chunks_with_embeddings = self.generate_embeddings(chunks)
            
            # Prepare response
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
            
            # --- MODIFICATION: Use print for visibility ---
            print(f"✅ Processing completed successfully for {file_name}")
            return result
            
        except Exception as e:
            logger.error(f"❌ Processing failed for {file_name}: {e}")
            return {
                "status": "error",
                "error": str(e),
                "file": file_name
            }

# Initialize processor
processor = AcademicDocumentProcessor()

@functions_framework.cloud_event
def process_file_upload(cloud_event):
    """
    Cloud Function triggered by file upload to GCS bucket
    """
    try:
        data = cloud_event.data
        bucket_name = data["bucket"]
        file_name = data["name"]
        
        # --- MODIFICATION: Use print for visibility ---
        print(f"🎯 Function triggered for: {file_name}")
        
        # Process the document
        result = processor.process_document(bucket_name, file_name)
        
        # TODO: Send result to your server/database
        
        # --- MODIFICATION: Use print for visibility ---
        print("🎉 Function completed successfully")
        return result
        
    except Exception as e:
        logger.error(f"💥 Function failed: {e}")
        return {"status": "error", "error": str(e)}