import '../config.mjs';
import { createExportWorker } from './queue.mjs';
import { exportMarkdown } from './fileExport.mjs';
import { completedExport, startExportCleanup } from './localExports.mjs';

const stopCleanup = startExportCleanup();
const worker = createExportWorker(async (job) => {
  const { markdownText, targetFormat, userId } = job.data;
  // Old pre-migration jobs have no ownership information and must not be exported.
  if (!userId) throw new Error('This export predates the local migration. Please request it again.');
  const filePath = await exportMarkdown(markdownText, targetFormat);
  return completedExport(filePath);
});

worker.on('completed', (job) => console.log('[Worker] Export ' + job.id + ' completed.'));
worker.on('failed', (job, error) => console.warn(JSON.stringify({
  event: 'export_failed', jobId: job?.id ?? 'unknown',
  format: ['pdf', 'docx'].includes(job?.data?.targetFormat) ? job.data.targetFormat : 'unknown',
  code: typeof error?.code === 'string' && /^EXPORT_[A-Z_]+$/.test(error.code) ? error.code : 'EXPORT_FAILED',
  ...(Number.isInteger(error?.exitCode) ? { exitCode: error.exitCode } : {}),
})));
worker.on('error', (error) => console.error('[Worker] Queue error:', error.code || error.name));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  stopCleanup();
  await worker.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('[Worker] Local export worker started.');
