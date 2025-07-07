// backend/queue.mjs (NEW FILE)
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

// This creates a Redis connection. BullMQ will reuse this.
// It automatically uses the REDIS_URL from your environment variables,
// which Render will provide.
const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null // Important for robustness
});

// Create a queue for file export tasks.
// We'll interact with this queue from our API server and our workers.
export const exportQueue = new Queue('file-export-queue', { connection });

// A helper function to create a worker.
// We'll call this from our worker.mjs file.
export const createExportWorker = (processor) => {
    // The worker processes jobs from the 'file-export-queue'.
    // The { concurrency: 2 } option means this single worker process
    // can handle up to 2 jobs at the same time.
    // Let's start with 1 for simplicity and predictability. You can increase this later.
    return new Worker('file-export-queue', processor, {
        connection,
        concurrency: 2 // Each worker server will process ONE job at a time.
    });
};

console.log('[Queue] BullMQ configured and exportQueue created.');