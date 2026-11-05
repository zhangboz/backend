import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { toFile } from 'openai';
import { AIError, getOpenAIClient, TEXT_MODEL, logUsage, safeAIError } from '../AI_ChatBot/openaiClient.mjs';
import { exportInstructions } from '../AI_ChatBot/exportPrompt.mjs';
import { createExportJobStore } from './exportJobStore.mjs';

export const MAX_MARKDOWN_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const requestOptions = { timeout: 30_000, maxRetries: 0 };
const terminal = new Set(['completed', 'failed', 'expired']);
const messages = {
  EXPORT_TIMEOUT: 'Document generation timed out. Please try a shorter document.',
  EXPORT_EMPTY_FILE: 'The AI service did not produce a document. Please try again.',
  EXPORT_INVALID_FILE: 'The AI service returned an invalid document. Please try again.',
  EXPORT_INCOMPLETE: 'The AI service could not finish formatting this document. Please try a shorter document.',
  EXPORT_TOO_LARGE: 'The generated file is too large. Please export a shorter document.',
  EXPORT_STORAGE_FULL: 'Temporary document storage is full. Please try again later.',
  AI_CREDIT_EXHAUSTED: 'OpenAI API credits are exhausted. Please contact the site owner.',
  AI_ACCESS_UNAVAILABLE: 'The server cannot access OpenAI document generation.',
  AI_RATE_LIMITED: 'The AI service is busy. Please try again shortly.',
};
export const exportFailureMessage = code => (typeof code === 'string' && Object.hasOwn(messages, code)) ? messages[code] : 'Document generation failed. Please try again.';

export function validateExportInput(markdown, format) {
  if (!['pdf', 'docx'].includes(format)) throw new AIError('Only PDF and Word exports are supported.', 400, 'INVALID_EXPORT_FORMAT');
  if (typeof markdown !== 'string' || !markdown.trim()) throw new AIError('Markdown text is required.', 400, 'INVALID_EXPORT_INPUT');
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) throw new AIError('Export text must be no larger than 64 KB.', 413, 'EXPORT_INPUT_TOO_LARGE');
}

// A model can create several files with the same basename. Only its final file
// citation, bound to this job's private container, selects the downloadable file.
export function finalArtifact(response, containerId, format) {
  const citations = (response.output ?? []).filter(item => item.type === 'message')
    .flatMap(item => item.content ?? []).filter(item => item.type === 'output_text')
    .flatMap(item => item.annotations ?? [])
    .filter(item => item.type === 'container_file_citation' && item.container_id === containerId &&
      typeof item.file_id === 'string' &&
      [`export.${format}`, `/mnt/data/export.${format}`].includes(item.filename));
  const artifact = citations.at(-1);
  if (!artifact) throw new AIError(messages.EXPORT_EMPTY_FILE, 502, 'EXPORT_EMPTY_FILE');
  return artifact;
}

export async function readBoundedDocument(response, format) {
  const statedLength = Number(response.headers?.get('content-length'));
  if (statedLength > MAX_OUTPUT_BYTES) {
    await response.body?.cancel();
    throw new AIError(messages.EXPORT_TOO_LARGE, 413, 'EXPORT_TOO_LARGE');
  }
  if (!response.body) throw new AIError(messages.EXPORT_EMPTY_FILE, 502, 'EXPORT_EMPTY_FILE');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_OUTPUT_BYTES) throw new AIError(messages.EXPORT_TOO_LARGE, 413, 'EXPORT_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks, size);
  const valid = format === 'pdf' ? buffer.subarray(0, 5).toString() === '%PDF-' :
    buffer.length > 4 && buffer.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]));
  if (!valid) throw new AIError(messages.EXPORT_INVALID_FILE, 502, 'EXPORT_INVALID_FILE');
  return buffer;
}

export function createOpenAIExportService({ store = createExportJobStore(), client, now = Date.now, logger = console } = {}) {
  const api = () => client || getOpenAIClient();
  let cleanupPromise;
  let lastCleanup = -Infinity;
  async function discardProvider(job) {
    const errors = [];
    const ignoreMissing = operation => operation.catch(error => { if (error.status !== 404) errors.push(error); });
    if (job.responseId) {
      if (job.state !== 'completed') {
        // Cancel can also report 400 for an already-terminal response.
        await api().responses.cancel(job.responseId, requestOptions).catch(error => {
          if (![400, 404].includes(error.status)) errors.push(error);
        });
      }
      await ignoreMissing(api().responses.delete(job.responseId, requestOptions));
    }
    if (job.containerId) await ignoreMissing(api().containers.delete(job.containerId, requestOptions));
    if (errors.length) {
      logger.warn?.('[Exports] Provider cleanup will retry', safeAIError(errors[0]).code);
      return;
    }
    await store.clearProvider(job.id);
  }
  async function cleanup({ force = false } = {}) {
    if (cleanupPromise) return cleanupPromise;
    if (!force && now() - lastCleanup < 60_000) return;
    lastCleanup = now();
    cleanupPromise = (async () => {
      const jobs = await store.cleanup();
      // Bounded work per user request; unfinished cleanup remains in Postgres.
      for (const job of jobs.slice(0, 2)) await discardProvider(job);
    })().catch(error => logger.warn?.('[Exports] Cleanup unavailable', error.code || 'EXPORT_CLEANUP_FAILED'))
      .finally(() => { cleanupPromise = null; });
    return cleanupPromise;
  }
  function scheduleCleanup() { void cleanup(); }

  async function create({ userId, markdownText, format, requestKey }) {
    validateExportInput(markdownText, format);
    if (requestKey != null && (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestKey))) {
      throw new AIError('Invalid export request key.', 400, 'INVALID_EXPORT_REQUEST');
    }
    api(); // Check configuration before reserving a database job.
    scheduleCleanup();
    const fingerprint = createHash('sha256').update(JSON.stringify([String(userId), format, markdownText, requestKey || randomUUID()])).digest('hex');
    let job = await store.create({ userId, format, requestKey: fingerprint });
    if (!job.created) return job;
    try {
      const container = await api().containers.create({
        name: 'document-export', memory_limit: '1g',
        expires_after: { anchor: 'last_active_at', minutes: 20 }, network_policy: { type: 'disabled' },
      }, requestOptions);
      job = { ...job, containerId: container.id };
      await store.setProvider(job.id, { containerId: container.id });
      const source = await api().containers.files.create(container.id, {
        file: await toFile(Buffer.from(markdownText, 'utf8'), 'source.md', { type: 'text/markdown' }),
      }, requestOptions);
      await store.setProvider(job.id, { sourceFileId: source.id });
      const response = await api().responses.create({
        model: TEXT_MODEL, reasoning: { effort: 'low' }, max_output_tokens: 8000,
        background: true, store: true,
        tools: [{ type: 'code_interpreter', container: container.id }], tool_choice: 'required',
        instructions: exportInstructions(format),
        input: `Read the whole UTF-8 Markdown file at ${source.path}. Faithfully typeset its contents into /mnt/data/export.${format}. Return the final file citation.`,
        safety_identifier: createHash('sha256').update(String(userId)).digest('hex'),
      }, requestOptions);
      job = { ...job, responseId: response.id };
      return await store.setProvider(job.id, { responseId: response.id });
    } catch (error) {
      const safe = safeAIError(error);
      await store.fail(job.id, { errorCode: safe.code }).catch(() => {});
      // Even if persisting a provider ID failed, clean up the IDs we received.
      await discardProvider({ ...job, state: 'failed' }).catch(() => {});
      throw safe;
    }
  }

  async function status(id, userId) {
    scheduleCleanup();
    let job = await store.getOwned(id, userId);
    if (!job) return null;
    if (terminal.has(job.state)) return job;
    if (Date.parse(job.expiresAt) <= now()) return { ...job, state: 'expired', errorCode: 'EXPORT_TIMEOUT' };
    const leased = await store.claimPoll(id, { leaseMs: 90_000 });
    if (!leased) return job;
    job = leased;
    try {
      const response = await api().responses.retrieve(job.responseId, {}, requestOptions);
      if (['queued', 'in_progress'].includes(response.status)) {
        return await store.updateProcessing(id, { pollToken: job.pollToken, delayMs: 4000 }) || job;
      }
      logUsage(logger, 'document_export', TEXT_MODEL, response.usage);
      if (response.status !== 'completed') {
        const error = response.error ? safeAIError(response.error) : null;
        throw new AIError(exportFailureMessage(error?.code || 'EXPORT_INCOMPLETE'), 502,
          ['AI_CREDIT_EXHAUSTED', 'AI_ACCESS_UNAVAILABLE'].includes(error?.code) ? error.code : 'EXPORT_INCOMPLETE');
      }
      const artifact = finalArtifact(response, job.containerId, job.format);
      const bytes = await api().containers.files.content.retrieve(artifact.file_id, { container_id: job.containerId }, { ...requestOptions, signal: AbortSignal.timeout(30_000) });
      const content = await readBoundedDocument(bytes, job.format);
      const completed = await store.complete(id, {
        content, fileName: `export-${now()}-${randomBytes(8).toString('hex')}.${job.format}`,
        providerFileId: artifact.file_id, containerId: job.containerId, pollToken: job.pollToken,
      });
      if (completed) {
        void discardProvider(completed).catch(error => logger.warn?.('[Exports] Cleanup deferred', error.code || 'EXPORT_CLEANUP_FAILED'));
        return completed;
      }
    } catch (error) {
      const safe = typeof error?.code === 'string' && error.code.startsWith('EXPORT_') ? error : safeAIError(error);
      // Transient polling failures must not dispatch a second paid model run.
      if (['AI_TIMEOUT', 'AI_RATE_LIMITED', 'AI_UPSTREAM_ERROR', 'EXPORT_STORE_UNAVAILABLE'].includes(safe.code) && error?.status !== 404) {
        await store.updateProcessing(id, { pollToken: job.pollToken, delayMs: 10_000 });
        return { ...job, warning: 'Document generation is still running. Retrying the status check.' };
      }
      const failed = await store.fail(id, { errorCode: safe.code, pollToken: job.pollToken });
      if (failed) {
        void discardProvider(failed).catch(() => {});
        return failed;
      }
    }
    return await store.getOwned(id, userId);
  }
  return { create, status, cleanup, findByFileName: name => store.findByFileName(name) };
}

export const openaiExports = createOpenAIExportService();
