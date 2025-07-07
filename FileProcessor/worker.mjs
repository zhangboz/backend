// backend/worker.mjs (NEW FILE)
import 'dotenv/config';
import { createExportWorker } from './queue.mjs';
import { exportMarkdown, scheduleFileDeletion } from './fileExport.mjs';
import path from 'node:path';

console.log('[Worker] Starting up...');

const processor = async (job) => {
    const { markdownText, targetFormat, host } = job.data;
    console.log(`[Worker] Picked up job ${job.id}: Convert to ${targetFormat}.`);

    try {
        // 1. Perform the heavy task
        const outputFilePath = await exportMarkdown(markdownText, targetFormat);
        const outputFileName = path.basename(outputFilePath);

        // 2. Construct the final download URL
        const downloadUrl = `${host}/api/exports/${outputFileName}`;
        console.log(`[Worker] Job ${job.id} successful. File at: ${downloadUrl}`);

        // 3. Schedule the file for deletion
        scheduleFileDeletion(outputFilePath, 10 * 60 * 1000); // 10 minutes

        // 4. Return the result. BullMQ will store this with the job.
        return { downloadUrl, fileName: outputFileName };

    } catch (error) {
        console.error(`[Worker] Job ${job.id} failed:`, error.message);
        // Throwing an error tells BullMQ the job failed. It can be configured to retry.
        throw error;
    }
};

// Create and start the worker
const worker = createExportWorker(processor);

worker.on('completed', (job, result) => {
  console.log(`[Worker] Job ${job.id} has completed with result:`, result.downloadUrl);
});

worker.on('failed', (job, err) => {
  console.log(`[Worker] Job ${job.id} has failed with error: ${err.message}`);
});

console.log('[Worker] Worker process is running and waiting for jobs.');