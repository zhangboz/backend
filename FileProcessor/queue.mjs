import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { exportConcurrency } from '../services/runtimeConfig.mjs';

const queueName = 'file-export-queue';
let queue;
let apiConnection;

function redisConnection(worker = false) {
  const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: worker ? null : 1,
    connectTimeout: 3000,
    enableOfflineQueue: worker,
    retryStrategy: (attempt) => Math.min(attempt * 250, 2000),
  });
  // Do not log Redis URLs, which can contain credentials.
  connection.on('error', () => {});
  return connection;
}

/** Lazily connect so unavailable Redis does not prevent the rest of the API starting. */
export async function getExportQueue() {
  if (!queue) {
    apiConnection = redisConnection();
    queue = new Queue(queueName, {
      connection: apiConnection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 3600, count: 1000 },
      },
    });
    queue.on('error', () => {});
  }
  const candidate = queue;
  const candidateConnection = apiConnection;
  let timer;
  try {
    await Promise.race([
      candidate.waitUntilReady(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Export queue unavailable. Start local Redis.')), 5000);
      }),
    ]);
    if (candidateConnection.status !== 'ready') throw new Error('Redis disconnected.');
    return candidate;
  } catch {
    if (queue === candidate) {
      queue = undefined;
      apiConnection = undefined;
      candidateConnection.disconnect();
      await candidate.close().catch(() => {});
    }
    throw Object.assign(new Error('Export queue unavailable. Start local Redis and the export worker.'), { statusCode: 503 });
  } finally {
    clearTimeout(timer);
  }
}

export function createExportWorker(processor) {
  const connection = redisConnection(true);
  const worker = new Worker(queueName, processor, { connection, concurrency: exportConcurrency() });
  worker.on('closed', () => connection.disconnect());
  return worker;
}

export async function closeExportQueue() {
  if (queue) await queue.close();
  apiConnection?.disconnect();
  queue = undefined;
  apiConnection = undefined;
}
