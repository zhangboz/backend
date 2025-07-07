// backend/worker.mjs (MODIFIED FOR GCS)
import 'dotenv/config';
import fs from 'fs-extra';
import path from 'node:path';
import { createExportWorker } from './queue.mjs';
import { exportMarkdown } from './fileExport.mjs';

// --- NEW IMPORTS FOR GCS ---
import { bucket } from './gcs_client.mjs'; // Use our new GCS client

console.log('[Worker] Starting up...');

const processor = async (job) => {
    const { markdownText, targetFormat } = job.data;
    console.log(`[Worker] Picked up job ${job.id}: Convert to ${targetFormat}.`);

    let localOutputFilePath = null; // Keep track of the local file for cleanup

    try {
        // 1. Perform the heavy task (generates file on worker's temporary local disk)
        localOutputFilePath = await exportMarkdown(markdownText, targetFormat);
        const outputFileName = path.basename(localOutputFilePath);

        if (!bucket) {
            throw new Error("GCS bucket is not configured. Check environment variables.");
        }

        // --- NEW: UPLOAD TO GCS ---
        console.log(`[Worker] Job ${job.id}: Uploading ${outputFileName} to GCS bucket ${bucket.name}...`);
        
        await bucket.upload(localOutputFilePath, {
            destination: outputFileName,
        });

        console.log(`[Worker] Job ${job.id}: GCS upload successful.`);
        const gcsFile = bucket.file(outputFileName);


        // --- NEW: CREATE A SIGNED DOWNLOAD URL ---
        const options = {
            version: 'v4',
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000, // 15 minutes
            responseDisposition: `attachment; filename="${outputFileName}"`, // Prompts download
        };
        const [downloadUrl] = await gcsFile.getSignedUrl(options);
        console.log(`[Worker] Job ${job.id} successful. GCS Signed URL generated.`);

        // 3. Return the result. The frontend will use this GCS URL directly.
        return { downloadUrl, fileName: outputFileName };

    } catch (error) {
        console.error(`[Worker] Job ${job.id} failed:`, error.message);
        throw error;
    } finally {
        // 4. Clean up the temporary file from the worker's local disk
        if (localOutputFilePath) {
            fs.unlink(localOutputFilePath)
              .then(() => console.log(`[Worker] Cleaned up local file: ${localOutputFilePath}`))
              .catch(err => console.error(`[Worker] Failed to cleanup local file: ${err.message}`));
        }
    }
};

// Create and start the worker (No change here)
const worker = createExportWorker(processor);

worker.on('completed', (job, result) => {
  console.log(`[Worker] Job ${job.id} has completed. Download URL ready.`);
});

worker.on('failed', (job, err) => {
  console.log(`[Worker] Job ${job.id} has failed with error: ${err.message}`);
});

console.log('[Worker] Worker process is running and waiting for jobs.');