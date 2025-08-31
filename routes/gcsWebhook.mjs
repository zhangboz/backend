// backend/routes/gcsWebhook.mjs
import express from 'express';
import db from '../db.mjs';
import adminStatusEmitter from '../services/eventService.mjs'; // <-- The crucial import

const router = express.Router();

router.post('/', async (req, res) => {
    console.log('[GCS Webhook] Received a new webhook event.');

    const { status, metadata, transcribed_text, chunks, error, file } = req.body;
    
    // The original filename is our key for emitting events back to the correct client
    const originalFileName = metadata?.original_file;

    // Handle case where the Cloud Function itself reports an error
    if (status === 'error') {
        console.error(`[GCS Webhook] Cloud function reported an error for file: ${file}. Error: ${error}`);
        // Let the frontend know about the cloud function error
        if (originalFileName) {
            adminStatusEmitter.emit(originalFileName, {
                status: 'error',
                message: `Error: Cloud function failed. ${error}`
            });
        }
        return res.status(400).json({ success: false, message: `Cloud function reported an error: ${error}` });
    }

    // Basic validation of the incoming payload structure
    if (!metadata || !transcribed_text || !Array.isArray(chunks)) {
        console.error('[GCS Webhook] Invalid payload structure:', req.body);
        return res.status(400).json({ success: false, message: 'Invalid payload structure received.' });
    }
    
    // --- EMIT "SAVING TO DB" STATUS --- //
    // This is the "Stage 4" update for the frontend.
    if (originalFileName) {
        console.log(`[Webhook Emitter] Emitting 'processing' (4/4) for file: ${originalFileName}`);
        adminStatusEmitter.emit(originalFileName, { 
            status: 'processing', 
            message: '4/4: Saving data to database...' 
        });
    }

    let client;
    try {
        client = await db.getClient();
        await client.query('BEGIN');

        // 1. Insert into 'documents' table
        const {
            mime_type,
            file_size,
            transcription_length,
            subject,
            institution,
            department,
            course_code,
            document_type
        } = metadata;

        const documentInsertQuery = `
            INSERT INTO documents (
                file_url, file_name, mime_type, file_size, transcription_length,
                subject, institution, department, course_code, document_type, transcribed_text
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id;
        `;
        const documentInsertValues = [
            originalFileName, originalFileName, mime_type, file_size,
            transcription_length, subject, institution, department,
            course_code, document_type, transcribed_text
        ];

        const documentResult = await client.query(documentInsertQuery, documentInsertValues);
        const documentId = documentResult.rows[0].id;
        console.log(`[GCS Webhook] Document inserted with ID: ${documentId}`);

        // 2. Insert into 'chunks' table
        const chunkInsertQuery = `
            INSERT INTO chunks (
                document_id, chunk_id, text, summary, start_pos, chunk_length, embedding
            ) VALUES ($1, $2, $3, $4, $5, $6, $7);
        `;

        for (const chunk of chunks) {
            const { chunk_id, text, summary, start_pos, chunk_length, embedding } = chunk;
            if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
                console.warn(`[GCS Webhook] Skipping chunk ${chunk_id} for document ${documentId} due to missing embedding.`);
                continue;
            }
            const embeddingString = `[${embedding.join(',')}]`;
            await client.query(chunkInsertQuery, [
                documentId, chunk_id, text, summary, start_pos, chunk_length, embeddingString
            ]);
        }
        console.log(`[GCS Webhook] Inserted ${chunks.length} chunks for document ID: ${documentId}`);

        await client.query('COMMIT');
        console.log('[GCS Webhook] Transaction committed successfully.');

        // --- EMIT "COMPLETE" STATUS --- //
        // This is the final "Done!" update for the frontend.
        if (originalFileName) {
            console.log(`[Webhook Emitter] Emitting 'complete' for file: ${originalFileName}`);
            adminStatusEmitter.emit(originalFileName, { 
                status: 'complete', 
                message: 'Done!' 
            });
        }

        res.status(200).json({ success: true, message: 'Document and chunks saved successfully!', documentId });

    } catch (dbError) {
        if (client) await client.query('ROLLBACK');
        console.error('[GCS Webhook] Error saving document and chunks:', dbError);
        
        // --- EMIT ERROR STATUS --- //
        // Let the frontend know if the database write failed.
        if (originalFileName) {
            console.log(`[Webhook Emitter] Emitting 'error' for file: ${originalFileName}`);
            adminStatusEmitter.emit(originalFileName, {
                status: 'error',
                message: `Error: DB write failed. ${dbError.message}`
            });
        }

        res.status(500).json({ success: false, message: 'Failed to save document and chunks to database.', error: dbError.message });
    } finally {
        if (client) client.release();
    }
});

export default router;