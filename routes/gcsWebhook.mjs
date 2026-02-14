// backend/routes/gcsWebhook.mjs
import express from 'express';
import db from '../db.mjs';
import redis from '../services/redisClient.mjs';
import { rawBucket } from '../FileProcessor/gcs_client.mjs';

const router = express.Router();

// --- NEW: Helper function to clean up resources on failure ---
async function handleProcessingFailure(fileName, errorMessage) {
    console.log(`[Cleanup] Initiating cleanup for failed file: ${fileName}. Reason: ${errorMessage}`);
    const statusKey = `status:${fileName}`;

    // 1. Database Cleanup
    let client;
    try {
        client = await db.getClient();
        const findDocQuery = 'SELECT id FROM documents WHERE file_url = $1';
        const docResult = await client.query(findDocQuery, [fileName]);

        if (docResult.rows.length > 0) {
            const documentId = docResult.rows[0].id;
            console.log(`[Cleanup] Deleting document record (ID: ${documentId}) and all related data from the database...`);
            // Assuming 'ON DELETE CASCADE' is set for foreign keys in 'chunks' and 'gcf_diagnostics' tables.
            await client.query('DELETE FROM documents WHERE id = $1', [documentId]);
            console.log(`[Cleanup] Successfully deleted document record for file: ${fileName}`);
        } else {
            console.warn(`[Cleanup] Could not find a document record for ${fileName}. No database cleanup needed.`);
        }
    } catch (dbError) {
        console.error(`[Cleanup] Database cleanup failed for ${fileName}:`, dbError);
        // We will continue to GCS cleanup even if this fails.
    } finally {
        if (client) client.release();
    }

    // 2. GCS File Cleanup
    try {
        if (!rawBucket) {
            throw new Error('GCS raw bucket client is not initialized.');
        }
        const file = rawBucket.file(fileName);
        const [exists] = await file.exists();
        if (exists) {
            await file.delete();
            console.log(`[Cleanup] Successfully deleted GCS file: ${fileName}`);
        } else {
            console.warn(`[Cleanup] GCS file not found, likely already deleted: ${fileName}`);
        }
    } catch (gcsError) {
        console.error(`[Cleanup] GCS file deletion failed for ${fileName}:`, gcsError);
    }

    // 3. Update Redis Status to reflect the failure and cleanup
    try {
        const payload = JSON.stringify({
            status: 'error',
            message: `Processing failed: ${errorMessage}. Associated records and the GCS file have been deleted.`
        });
        // Keep the error message for an hour for debugging purposes.
        await redis.set(statusKey, payload, 'EX', 3600);
    } catch (redisError) {
        console.error(`[Cleanup] Failed to set final error status in Redis for ${fileName}:`, redisError);
    }
}


// --- MODIFIED: Helper function to find or create diagnostics entry ---
async function findOrCreateDiagnosticsEntry(client, fullGcsPath) {
    try {
        // First, try to find existing diagnostics entry
        const findQuery = 'SELECT id, document_id FROM gcf_diagnostics WHERE file_url = $1';
        const findResult = await client.query(findQuery, [fullGcsPath]);
        
        if (findResult.rows.length > 0) {
            console.log(`[Diagnostics] Found existing diagnostics entry with ID: ${findResult.rows[0].id}`);
            return {
                diagnosticsId: findResult.rows[0].id,
                documentId: findResult.rows[0].document_id,
                isNew: false
            };
        }
        
        // If not found, find the document and create new diagnostics entry
        const findDocQuery = 'SELECT id FROM documents WHERE file_url = $1';
        const docResult = await client.query(findDocQuery, [fullGcsPath]);
        
        if (docResult.rows.length === 0) {
            // This can happen if a cleanup has already occurred, which is not an error in that context.
            console.warn(`[Diagnostics] Document with URL '${fullGcsPath}' not found. It may have been deleted due to a prior failure.`);
            return { diagnosticsId: null, documentId: null, isNew: false };
        }
        
        const documentId = docResult.rows[0].id;
        
        // Create new diagnostics entry
        const createQuery = `
            INSERT INTO gcf_diagnostics (document_id, file_url, created_at)
            VALUES ($1, $2, NOW())
            RETURNING id
        `;
        const createResult = await client.query(createQuery, [documentId, fullGcsPath]);
        const diagnosticsId = createResult.rows[0].id;
        
        console.log(`[Diagnostics] Created new diagnostics entry with ID: ${diagnosticsId} for document ID: ${documentId}`);
        return {
            diagnosticsId: diagnosticsId,
            documentId: documentId,
            isNew: true
        };
        
    } catch (error) {
        console.error(`[Diagnostics] Error finding or creating diagnostics entry: ${error.message}`);
        throw error;
    }
}

// --- HEAVILY MODIFIED: Handler for incremental updates to use the new cleanup logic ---
async function handleIncrementalUpdate(req, res) {
    const { update_type, file_name, data } = req.body;
    
    console.log(`[GCS Webhook] Received ${update_type} update for file: ${file_name}`);
    
    const statusKey = file_name ? `status:${file_name}` : null;
    
    // --- NEW: Handle failure types first by calling the cleanup function ---
    if (['transcription_error', 'chunking_error', 'processing_error'].includes(update_type)) {
        const errorMessage = data.error || `An unknown error occurred during the '${update_type}' step.`;
        await handleProcessingFailure(file_name, errorMessage);
        
        // Acknowledge the webhook request
        return res.status(200).json({ 
            success: true, 
            message: `Failure event '${update_type}' acknowledged. Cleanup process initiated.` 
        });
    }

    let client;
    try {
        client = await db.getClient();
        
        const { diagnosticsId, documentId } = await findOrCreateDiagnosticsEntry(client, file_name);
        
        // If documentId is null, it means the record was likely deleted. Abort further processing.
        if (!documentId) {
            console.warn(`[GCS Webhook] Aborting '${update_type}' for ${file_name} because the document record no longer exists.`);
            return res.status(200).json({ success: true, message: "Orphaned event ignored; document already deleted." });
        }
        
        switch (update_type) {
            case 'transcription_complete':
                if (statusKey) {
                    const payload = JSON.stringify({ status: 'processing', message: '2/4: Transcription completed, extracting metadata...' });
                    await redis.set(statusKey, payload, 'KEEPTTL');
                }
                const transcriptionUpdateQuery = `
                    UPDATE gcf_diagnostics 
                    SET transcribed_characters = $1, transcription_tokens = $2, transcription_time = $3, transcription_success = $4
                    WHERE id = $5
                `;
                await client.query(transcriptionUpdateQuery, [
                    data.transcribed_characters || 0, data.transcription_tokens || 0,
                    data.transcription_time || 0, data.transcription_success || false, diagnosticsId
                ]);
                if (data.transcribed_text) {
                    await client.query('UPDATE documents SET transcribed_text = $1 WHERE id = $2', [data.transcribed_text, documentId]);
                }
                console.log(`[Transcription] Updated diagnostics and document for ID: ${documentId}`);
                break;
                
            case 'metadata_extracted':
                if (statusKey) {
                    const payload = JSON.stringify({ status: 'processing', message: '3/4: Metadata extracted, creating chunks...' });
                    await redis.set(statusKey, payload, 'KEEPTTL');
                }
                if (data.document_type) {
                    await client.query('UPDATE documents SET document_type = $1 WHERE id = $2', [data.document_type, documentId]);
                }
                console.log(`[Metadata] Updated document ID: ${documentId} with type: ${data.document_type}`);
                break;
                
            case 'chunking_complete':
                if (statusKey) {
                    const payload = JSON.stringify({ status: 'processing', message: '4/4: Chunks created, generating embeddings...' });
                    await redis.set(statusKey, payload, 'KEEPTTL');
                }
                const chunkingUpdateQuery = `
                    UPDATE gcf_diagnostics 
                    SET chunks_count = $1, total_chunk_characters = $2, chunking_tokens = $3, chunking_time = $4, chunking_success = $5
                    WHERE id = $6
                `;
                await client.query(chunkingUpdateQuery, [
                    data.chunks_count || 0, data.total_chunk_characters || 0,
                    data.chunking_tokens || 0, data.chunking_time || 0,
                    data.chunking_success || false, diagnosticsId
                ]);
                console.log(`[Chunking] Updated diagnostics for ID: ${diagnosticsId} with chunking data.`);
                break;
                
            case 'embeddings_complete':
                if (statusKey) {
                    const payload = JSON.stringify({ status: 'processing', message: '5/5: Embeddings generated, saving to database...' });
                    await redis.set(statusKey, payload, 'KEEPTTL');
                }
                if (data.chunks_with_embeddings?.length > 0) {
                    const chunkInsertQuery = `
                        INSERT INTO chunks (document_id, chunk_id, text, summary, start_pos, chunk_length, embedding) 
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        ON CONFLICT (document_id, chunk_id) DO UPDATE SET 
                            text = EXCLUDED.text, summary = EXcluded.summary, start_pos = EXCLUDED.start_pos,
                            chunk_length = EXCLUDED.chunk_length, embedding = EXCLUDED.embedding;
                    `;
                    let chunksInserted = 0;
                    for (const chunk of data.chunks_with_embeddings) {
                        if (chunk.embedding?.length > 0) {
                            const embeddingString = `[${chunk.embedding.join(',')}]`;
                            await client.query(chunkInsertQuery, [
                                documentId, chunk.chunk_id, chunk.text, chunk.summary, 
                                chunk.start_pos, chunk.chunk_length, embeddingString
                            ]);
                            chunksInserted++;
                        }
                    }
                    console.log(`[Embeddings] Inserted/updated ${chunksInserted} chunks for document ID: ${documentId}`);
                }
                break;
                
            case 'processing_complete':
                if (statusKey) {
                    const payload = JSON.stringify({ status: 'complete', message: 'Processing completed successfully!' });
                    await redis.set(statusKey, payload, 'EX', 3600); // Keep success message for 1 hour
                }
                if (data.total_time !== undefined) {
                    await client.query('UPDATE gcf_diagnostics SET total_time = $1 WHERE id = $2', [data.total_time, diagnosticsId]);
                }
                console.log(`[Complete] Processing finished for file: ${file_name} in ${data.total_time}s`);
                break;

            default:
                console.warn(`[GCS Webhook] Unknown update_type: ${update_type}`);
                return res.status(400).json({ success: false, message: `Unknown update_type: ${update_type}` });
        }
        
        res.status(200).json({ 
            success: true, 
            message: `${update_type} update processed successfully`,
            documentId: documentId
        });
        
    } catch (error) {
        console.error(`[GCS Webhook] Error processing '${update_type}' update for ${file_name}:`, error);
        if (statusKey) {
            const payload = JSON.stringify({ status: 'error', message: `Webhook internal error: ${error.message}` });
            await redis.set(statusKey, payload, 'EX', 3600);
        }
        res.status(500).json({ success: false, message: `Failed to process ${update_type} update`, error: error.message });
    } finally {
        if (client) client.release();
    }
}

// --- MODIFIED: Main router routes to the new incremental handler ---
router.post('/', async (req, res) => {
    console.log('[GCS Webhook] Received webhook event.');
    
    // The new system only uses incremental updates with an 'update_type' field.
    if (req.body.update_type && req.body.file_name) {
        return handleIncrementalUpdate(req, res);
    }
    
    // Kept for backward compatibility, but this path is now deprecated.
    console.warn('[GCS Webhook] Received a legacy payload. Please update the Cloud Function to send incremental updates.');
    const { status, error, file } = req.body;
    if (status === 'error') {
        await handleProcessingFailure(file, error);
        return res.status(200).json({ success: true, message: "Legacy failure acknowledged and cleaned up." });
    }

    console.error('[GCS Webhook] Received an invalid or unsupported payload format.');
    return res.status(400).json({ success: false, message: 'Invalid or unsupported payload format.' });
});

export default router;