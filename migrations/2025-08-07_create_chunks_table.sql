-- Enable pgvector extension (needed for vector storage)
CREATE EXTENSION IF NOT EXISTS vector;

-- Table for documents
CREATE TABLE documents (
    id SERIAL PRIMARY KEY,
    file_url TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT,
    file_size INTEGER,
    transcription_length INTEGER,
    subject TEXT,
    institution TEXT,
    department TEXT,
    course_code TEXT,
    document_type TEXT,
    transcribed_text TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table for chunks
CREATE TABLE chunks (
    id SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    chunk_id INTEGER,
    text TEXT,
    summary TEXT,
    start_pos INTEGER,
    chunk_length INTEGER,
    embedding VECTOR(768), -- Gemini returns 768-length embeddings
    created_at TIMESTAMPTZ DEFAULT NOW()
);
