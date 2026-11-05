import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  createOpenAIExportService, finalArtifact, readBoundedDocument,
  validateExportInput, MAX_MARKDOWN_BYTES, MAX_OUTPUT_BYTES,
} from '../services/openaiExports.mjs';

const NOW = Date.UTC(2026, 10, 4, 20);
const quiet = { info() {}, warn() {} };
const pdf = Buffer.from('%PDF-1.7\nsynthetic offline test\n%%EOF');
const docx = Buffer.from([80, 75, 3, 4, 0, 0, 0, 0]);
const citation = (fileId = 'cfile_final', containerId = 'cntr_1', filename = 'export.pdf') => ({
  type: 'container_file_citation', file_id: fileId, container_id: containerId, filename,
});
const completedResponse = (annotations = [citation()]) => ({
  id: 'resp_1', status: 'completed', usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'Download', annotations }] }],
});

// Every external dependency is injected. No database, filesystem conversion,
// or OpenAI network request is made by this test fixture.
function fixture({ seed, response, content, cleanupJobs = [] } = {}) {
  const calls = {};
  const rows = new Map();
  if (seed) rows.set(seed.id, { ...seed });
  const note = (name, args) => (calls[name] ??= []).push(args);
  const copy = row => {
    if (!row) return null;
    const { content: _content, ...metadata } = row;
    return { ...metadata };
  };
  const change = (id, patch) => {
    const row = rows.get(id);
    if (!row) throw new Error('Unexpected fake-store job');
    Object.assign(row, patch);
    return copy(row);
  };
  const store = {
    async create(body) {
      note('store.create', [body]);
      const previous = [...rows.values()].find(row => row.userId === String(body.userId) && row.requestKey === body.requestKey);
      if (previous) return { ...copy(previous), created: false };
      const row = {
        id: `job_${rows.size + 1}`, userId: String(body.userId), format: body.format,
        requestKey: body.requestKey, state: 'starting', expiresAt: new Date(NOW + 600_000).toISOString(),
      };
      rows.set(row.id, row);
      return { ...copy(row), created: true };
    },
    async setProvider(id, patch) {
      note('store.setProvider', [id, patch]);
      return change(id, { ...patch, ...(patch.responseId ? { state: 'processing' } : {}) });
    },
    async getOwned(id, userId) {
      note('store.getOwned', [id, userId]);
      const row = rows.get(id);
      return row?.userId === String(userId) ? copy(row) : null;
    },
    async claimPoll(id) {
      note('store.claimPoll', [id]);
      const row = rows.get(id);
      if (row.state !== 'processing' || !row.responseId || row.pollToken) return null;
      return change(id, { pollToken: `lease_${calls['store.claimPoll'].length}` });
    },
    async updateProcessing(id, patch) {
      note('store.updateProcessing', [id, patch]);
      if (rows.get(id)?.pollToken !== patch.pollToken) return null;
      return change(id, { state: 'processing', pollToken: null });
    },
    async complete(id, patch) {
      note('store.complete', [id, patch]);
      if (rows.get(id)?.pollToken !== patch.pollToken) return null;
      return change(id, {
        ...patch, state: 'completed', pollToken: null,
        expiresAt: new Date(NOW + 3_600_000).toISOString(),
        downloadExpiresAt: new Date(NOW + 900_000).toISOString(),
      });
    },
    async fail(id, patch) {
      note('store.fail', [id, patch]);
      return change(id, { state: 'failed', errorCode: patch.errorCode, pollToken: null });
    },
    async cleanup() { note('store.cleanup', []); return cleanupJobs; },
    async clearProvider(id) {
      note('store.clearProvider', [id]);
      return change(id, { responseId: null, containerId: null, sourceFileId: null, providerFileId: null });
    },
    async findByFileName(name) {
      note('store.findByFileName', [name]);
      const row = [...rows.values()].find(item => item.fileName === name && item.state === 'completed');
      return row ? { ...row } : null;
    },
  };
  let containerNumber = 0;
  const client = {
    containers: {
      async create(...args) { note('containers.create', args); return { id: `cntr_${++containerNumber}` }; },
      async delete(...args) { note('containers.delete', args); },
      files: {
        async create(...args) { note('files.create', args); return { id: 'cfile_source', path: '/mnt/data/source.md' }; },
        content: { async retrieve(...args) {
          note('files.content.retrieve', args);
          if (typeof content === 'function') return content(...args);
          return new Response(content ?? pdf);
        } },
      },
    },
    responses: {
      async create(...args) { note('responses.create', args); return { id: `resp_${calls['responses.create'].length}`, status: 'queued' }; },
      async retrieve(...args) {
        note('responses.retrieve', args);
        return typeof response === 'function' ? response(...args) : response ?? completedResponse();
      },
      async cancel(...args) { note('responses.cancel', args); },
      async delete(...args) { note('responses.delete', args); },
    },
  };
  const options = { store, client, now: () => NOW, logger: quiet };
  return { store, client, rows, calls, options, service: createOpenAIExportService(options) };
}
const seed = (patch = {}) => ({
  id: 'job_saved', userId: '7', format: 'pdf', state: 'processing',
  responseId: 'resp_saved', containerId: 'cntr_1', sourceFileId: 'cfile_source',
  expiresAt: new Date(NOW + 600_000).toISOString(), ...patch,
});
const request = (patch = {}) => ({ userId: '7', markdownText: '# 中文\n\nKeep ||x||.', format: 'pdf', requestKey: 'request_1234', ...patch });
const count = (f, name) => f.calls[name]?.length ?? 0;

// Boundary checks protect the paid dispatch path, including UTF-8 byte limits.
test('exports accept only nonempty PDF/DOCX Markdown within the UTF-8 byte limit', () => {
  for (const format of ['pdf', 'docx']) assert.doesNotThrow(() => validateExportInput('中'.repeat(10), format));
  assert.doesNotThrow(() => validateExportInput('a'.repeat(MAX_MARKDOWN_BYTES), 'pdf'));
  for (const format of ['PDF', 'html', '', null]) assert.throws(() => validateExportInput('text', format), { code: 'INVALID_EXPORT_FORMAT' });
  for (const text of ['', ' \n\t ', null, {}, 3]) assert.throws(() => validateExportInput(text, 'pdf'), { code: 'INVALID_EXPORT_INPUT' });
  assert.throws(() => validateExportInput('a'.repeat(MAX_MARKDOWN_BYTES + 1), 'pdf'), { code: 'EXPORT_INPUT_TOO_LARGE', statusCode: 413 });
  assert.throws(() => validateExportInput('中'.repeat(Math.floor(MAX_MARKDOWN_BYTES / 3) + 1), 'pdf'), { code: 'EXPORT_INPUT_TOO_LARGE' });
});

test('invalid input or idempotency keys do not reserve jobs or call a provider', async () => {
  const f = fixture();
  for (const patch of [{ markdownText: '' }, { format: 'exe' }, { requestKey: 'short' }, { requestKey: '../secret' }, { requestKey: 7 }]) {
    await assert.rejects(f.service.create(request(patch)));
  }
  assert.equal(count(f, 'store.create'), 0);
  assert.equal(count(f, 'containers.create'), 0);
  assert.equal(count(f, 'responses.create'), 0);
});

test('final artifact uses final message citations and binds format and private container', () => {
  const response = completedResponse([
    citation('cfile_older'), citation('cfile_final'),
    citation('cfile_other_user', 'cntr_other'), citation('cfile_docx', 'cntr_1', 'export.docx'),
  ]);
  response.output.unshift({ type: 'code_interpreter_call', outputs: [{ annotations: [citation('cfile_preview')] }] });
  assert.equal(finalArtifact(response, 'cntr_1', 'pdf').file_id, 'cfile_final');
  assert.equal(finalArtifact(response, 'cntr_1', 'docx').file_id, 'cfile_docx');
  for (const bad of [completedResponse([]), completedResponse([citation('foreign', 'cntr_other')]), completedResponse([citation('other', 'cntr_1', 'preview.pdf')])]) {
    assert.throws(() => finalArtifact(bad, 'cntr_1', 'pdf'), { code: 'EXPORT_EMPTY_FILE' });
  }
});

test('document downloads enforce size from both headers and actual streamed bytes', async () => {
  assert.deepEqual(await readBoundedDocument(new Response(pdf), 'pdf'), pdf);
  assert.deepEqual(await readBoundedDocument(new Response(docx), 'docx'), docx);
  let canceled = false;
  const oversizedHeader = {
    headers: new Headers({ 'content-length': String(MAX_OUTPUT_BYTES + 1) }),
    body: { async cancel() { canceled = true; } },
  };
  await assert.rejects(readBoundedDocument(oversizedHeader, 'pdf'), { code: 'EXPORT_TOO_LARGE' });
  assert.equal(canceled, true);
  let returned = false;
  const actualOverflow = {
    headers: new Headers({ 'content-length': '5' }),
    body: (async function* () {
      try { yield Buffer.alloc(MAX_OUTPUT_BYTES); yield Buffer.from('overflow'); }
      finally { returned = true; }
    })(),
  };
  await assert.rejects(readBoundedDocument(actualOverflow, 'pdf'), { code: 'EXPORT_TOO_LARGE' });
  assert.equal(returned, true, 'stream must be closed after exceeding the limit');
  for (const [data, format] of [[Buffer.alloc(0), 'pdf'], [Buffer.from('<html>error</html>'), 'pdf'], [pdf, 'docx'], [docx, 'pdf']]) {
    await assert.rejects(readBoundedDocument(new Response(data), format), { code: 'EXPORT_INVALID_FILE' });
  }
});

test('create starts fixed Terra in background using a private network-disabled container', async () => {
  const f = fixture();
  const job = await f.service.create(request());
  assert.equal(job.state, 'processing');
  const [container, containerOptions] = f.calls['containers.create'][0];
  assert.equal(container.memory_limit, '1g');
  assert.deepEqual(container.network_policy, { type: 'disabled' });
  assert.deepEqual(container.expires_after, { anchor: 'last_active_at', minutes: 20 });
  assert.equal(containerOptions.maxRetries, 0);
  const [containerId, upload] = f.calls['files.create'][0];
  assert.equal(containerId, 'cntr_1');
  assert.equal(upload.file.name, 'source.md');
  assert.equal(await upload.file.text(), request().markdownText);
  const [body, options] = f.calls['responses.create'][0];
  assert.equal(body.model, 'gpt-6.1-terra');
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.equal(body.background, true);
  assert.equal(body.store, true);
  assert.equal(body.max_output_tokens, 8000);
  assert.deepEqual(body.tools, [{ type: 'code_interpreter', container: 'cntr_1' }]);
  assert.equal(body.tool_choice, 'required');
  assert.match(body.instructions, /Do not use Pandoc/);
  assert.match(body.instructions, /untrusted DATA/);
  assert.match(body.instructions, /Preserve both bars/);
  assert.match(body.input, /\/mnt\/data\/export\.pdf/);
  assert.equal(body.input.includes(request().markdownText), false);
  assert.match(body.safety_identifier, /^[a-f0-9]{64}$/);
  assert.equal(options.maxRetries, 0);
  assert.ok(options.timeout <= 30_000);
  assert.deepEqual(f.calls['store.setProvider'].map(([, patch]) => patch), [
    { containerId: 'cntr_1' }, { sourceFileId: 'cfile_source' }, { responseId: 'resp_1' },
  ]);
});

test('same owner, source, format and request key returns existing job without another paid run', async () => {
  const f = fixture();
  const first = await f.service.create(request());
  const duplicate = await f.service.create(request());
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.created, false);
  assert.equal(count(f, 'responses.create'), 1);
  assert.equal(count(f, 'containers.create'), 1);
  assert.equal(count(f, 'files.create'), 1);
  await f.service.create(request({ userId: 'another-user' }));
  assert.equal(count(f, 'responses.create'), 2);
  assert.notEqual(f.calls['store.create'][0][0].requestKey, f.calls['store.create'][2][0].requestKey);
});

test('a reconstructed service finishes persisted provider IDs and serves durable bytes after provider cleanup', async () => {
  const f = fixture();
  const started = await f.service.create(request());
  const restarted = createOpenAIExportService(f.options);
  const done = await restarted.status(started.id, '7');
  assert.equal(done.state, 'completed');
  assert.equal(count(f, 'responses.create'), 1);
  assert.equal(f.calls['responses.retrieve'][0][0], 'resp_1');
  assert.deepEqual(f.calls['files.content.retrieve'][0].slice(0, 2), ['cfile_final', { container_id: 'cntr_1' }]);
  const [, completion] = f.calls['store.complete'][0];
  assert.deepEqual(completion.content, pdf);
  assert.equal(completion.providerFileId, 'cfile_final');
  assert.match(completion.fileName, /^export-\d{13}-[a-f0-9]{16}\.pdf$/);
  assert.equal(completion.pollToken, 'lease_1');
  await nextTurn();
  assert.equal(count(f, 'responses.cancel'), 0);
  assert.equal(f.calls['responses.delete'][0][0], 'resp_1');
  assert.equal(f.calls['containers.delete'][0][0], 'cntr_1');
  assert.equal(count(f, 'store.clearProvider'), 1);
  const downloaded = await restarted.findByFileName(done.fileName);
  assert.deepEqual(downloaded.content, pdf);
  assert.equal(downloaded.containerId, null);
  assert.equal((await restarted.status(started.id, '7')).state, 'completed');
  assert.equal(count(f, 'responses.retrieve'), 1);
});

test('owner mismatch and an existing poll lease cannot retrieve or download provider artifacts', async () => {
  const f = fixture({ seed: seed({ pollToken: 'another-request-lease' }) });
  assert.equal(await f.service.status('job_saved', 'other-user'), null);
  const waiting = await f.service.status('job_saved', '7');
  assert.equal(waiting.state, 'processing');
  assert.equal(count(f, 'responses.retrieve'), 0);
  assert.equal(count(f, 'files.content.retrieve'), 0);
});

test('a transient poll timeout preserves the same response ID without dispatching another model run', async () => {
  let poll = 0;
  const f = fixture({ seed: seed(), response: () => {
    if (++poll === 1) throw Object.assign(new Error('simulated timeout'), { name: 'APIConnectionTimeoutError' });
    return completedResponse();
  } });
  const retry = await f.service.status('job_saved', '7');
  assert.equal(retry.state, 'processing');
  assert.match(retry.warning, /Retrying/);
  assert.equal(f.calls['store.updateProcessing'][0][1].delayMs, 10_000);
  assert.equal(count(f, 'store.fail'), 0);
  assert.equal(count(f, 'responses.cancel'), 0);
  assert.equal((await f.service.status('job_saved', '7')).state, 'completed');
  assert.deepEqual(f.calls['responses.retrieve'].map(([id]) => id), ['resp_saved', 'resp_saved']);
  assert.equal(count(f, 'responses.create'), 0);
  assert.equal(count(f, 'containers.create'), 0);
  await nextTurn();
});

test('queued and in-progress provider jobs release their poll leases for later checks', async () => {
  for (const status of ['queued', 'in_progress']) {
    const f = fixture({ seed: seed(), response: { status } });
    assert.equal((await f.service.status('job_saved', '7')).state, 'processing');
    assert.equal(f.calls['store.updateProcessing'][0][1].delayMs, 4000);
    assert.equal(f.rows.get('job_saved').pollToken, null);
    assert.equal(count(f, 'files.content.retrieve'), 0);
    assert.equal(count(f, 'responses.create'), 0);
  }
});

test('incomplete, missing and cross-user artifacts fail safely and clean up provider resources', async () => {
  for (const [response, expectedCode] of [
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'EXPORT_INCOMPLETE'],
    [completedResponse([]), 'EXPORT_EMPTY_FILE'],
    [completedResponse([citation('foreign', 'cntr_other')]), 'EXPORT_EMPTY_FILE'],
    [{ status: 'failed', error: { code: 'insufficient_quota' } }, 'AI_CREDIT_EXHAUSTED'],
  ]) {
    const f = fixture({ seed: seed(), response });
    const result = await f.service.status('job_saved', '7');
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, expectedCode);
    assert.equal(count(f, 'files.content.retrieve'), 0);
    assert.equal(count(f, 'responses.create'), 0);
    await nextTurn();
    assert.equal(f.calls['responses.cancel'][0][0], 'resp_saved');
    assert.equal(f.calls['responses.delete'][0][0], 'resp_saved');
    assert.equal(f.calls['containers.delete'][0][0], 'cntr_1');
    assert.equal(count(f, 'store.clearProvider'), 1);
  }
});

test('a deleted final file or invalid bytes cannot become a completed export', async () => {
  for (const content of [() => { throw { status: 404 }; }, Buffer.from('not a PDF')]) {
    const f = fixture({ seed: seed(), content });
    const result = await f.service.status('job_saved', '7');
    assert.equal(result.state, 'failed');
    assert.equal(count(f, 'store.complete'), 0);
    assert.equal(count(f, 'responses.create'), 0);
    await nextTurn();
    assert.equal(count(f, 'containers.delete'), 1);
  }
});

test('failure to persist a received response ID still cancels and deletes that response', async () => {
  const f = fixture();
  const setProvider = f.store.setProvider;
  f.store.setProvider = async (id, patch) => {
    if (patch.responseId) throw Object.assign(new Error('simulated persistence outage'), { code: 'EXPORT_STORE_UNAVAILABLE' });
    return setProvider(id, patch);
  };
  await assert.rejects(f.service.create(request()));
  assert.equal(f.calls['responses.cancel'][0][0], 'resp_1');
  assert.equal(f.calls['responses.delete'][0][0], 'resp_1');
  assert.equal(f.calls['containers.delete'][0][0], 'cntr_1');
  assert.equal(f.rows.get('job_1').state, 'failed');
});

test('cleanup ignores already-removed resources, is bounded, and retries failures without clearing IDs', async () => {
  const job = seed({ state: 'expired' });
  const f = fixture({ seed: job, cleanupJobs: [job] });
  let failDeletion = true;
  f.client.responses.cancel = async (...args) => { (f.calls['responses.cancel'] ??= []).push(args); throw { status: 400 }; };
  f.client.responses.delete = async (...args) => { (f.calls['responses.delete'] ??= []).push(args); throw { status: 404 }; };
  f.client.containers.delete = async (...args) => {
    (f.calls['containers.delete'] ??= []).push(args);
    if (failDeletion) throw { status: 503 };
  };
  await f.service.cleanup({ force: true });
  assert.equal(count(f, 'store.clearProvider'), 0);
  assert.equal(f.rows.get(job.id).containerId, 'cntr_1');
  failDeletion = false;
  await f.service.cleanup({ force: true });
  assert.equal(count(f, 'store.clearProvider'), 1);
  assert.equal(f.rows.get(job.id).containerId, null);
  const terminalJobs = [1, 2, 3].map(index => seed({ id: `old_${index}`, state: 'failed' }));
  const bounded = fixture({ cleanupJobs: terminalJobs });
  for (const row of terminalJobs) bounded.rows.set(row.id, row);
  await bounded.service.cleanup({ force: true });
  assert.equal(count(bounded, 'containers.delete'), 2);
  assert.equal(count(bounded, 'store.clearProvider'), 2);
});

test('a preview path cited after the final path must not replace the final download', () => {
  const response = completedResponse([
    citation('cfile_final', 'cntr_1', '/mnt/data/export.pdf'),
    citation('cfile_preview', 'cntr_1', '/mnt/data/check/export.pdf'),
  ]);
  assert.equal(finalArtifact(response, 'cntr_1', 'pdf').file_id, 'cfile_final');
  assert.throws(() => finalArtifact(completedResponse([
    citation('cfile_preview', 'cntr_1', '/mnt/data/check/export.pdf'),
  ]), 'cntr_1', 'pdf'), { code: 'EXPORT_EMPTY_FILE' });
});

test('persisted DOCX jobs download only the Word citation and preserve the document bytes', async () => {
  const f = fixture({
    seed: seed({ format: 'docx' }), content: docx,
    response: completedResponse([citation('cfile_pdf'), citation('cfile_word', 'cntr_1', 'export.docx')]),
  });
  const result = await f.service.status('job_saved', '7');
  assert.equal(result.state, 'completed');
  assert.match(result.fileName, /\.docx$/);
  assert.equal(f.calls['files.content.retrieve'][0][0], 'cfile_word');
  assert.deepEqual(f.calls['store.complete'][0][1].content, docx);
  assert.equal(count(f, 'responses.create'), 0);
  await nextTurn();
});

test('Responses polling passes an empty query separately from SDK request timeout options', async () => {
  const f = fixture({ seed: seed(), response: { status: 'in_progress' } });
  assert.equal((await f.service.status('job_saved', '7')).state, 'processing');
  const args = f.calls['responses.retrieve'][0];
  assert.equal(args.length, 3, 'SDK signature is retrieve(responseId, query, options)');
  assert.equal(args[0], 'resp_saved');
  assert.deepEqual(args[1], {}, 'timeout/maxRetries must not become URL query parameters');
  assert.deepEqual(args[2], { timeout: 30_000, maxRetries: 0 });
  assert.equal(count(f, 'responses.create'), 0);
});

test('binary download deadline aborts a stalled body and retries the same persisted job', async t => {
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController();
    deadlines.push({ milliseconds, controller });
    return controller.signal;
  });
  let bodyStarted;
  const waitingForBody = new Promise(resolve => { bodyStarted = resolve; });
  let bodyInterrupted = false;
  let downloads = 0;
  const f = fixture({ seed: seed(), content: (fileId, query, options) => {
    assert.equal(fileId, 'cfile_final');
    assert.deepEqual(query, { container_id: 'cntr_1' });
    assert.equal(options.timeout, 30_000);
    assert.equal(options.maxRetries, 0);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal, deadlines.at(-1).controller.signal);
    assert.equal(options.signal.aborted, false);
    if (++downloads > 1) return new Response(pdf);
    // Headers arrive, but the body never finishes until its request signal aborts.
    // No sleep, network request, or production timeout change is needed.
    return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => {
        bodyInterrupted = true;
        controller.error(options.signal.reason);
      }, { once: true });
      bodyStarted();
    } }));
  } });
  const pending = f.service.status('job_saved', '7');
  await waitingForBody;
  assert.equal(deadlines[0].milliseconds, 30_000);
  assert.equal(count(f, 'store.complete'), 0);
  deadlines[0].controller.abort(new DOMException('Synthetic body deadline exceeded', 'TimeoutError'));
  const retry = await pending;
  assert.equal(bodyInterrupted, true, 'the signal must interrupt body consumption, not only race a timer');
  assert.equal(retry.state, 'processing');
  assert.match(retry.warning, /Retrying/);
  assert.equal(f.calls['store.updateProcessing'][0][1].delayMs, 10_000);
  assert.equal(f.rows.get('job_saved').pollToken, null);
  assert.equal(count(f, 'store.fail'), 0);
  assert.equal(count(f, 'store.complete'), 0);
  assert.equal(count(f, 'responses.cancel'), 0);
  const completed = await f.service.status('job_saved', '7');
  assert.equal(completed.state, 'completed');
  assert.equal(deadlines.length, 2);
  assert(deadlines.every(deadline => deadline.milliseconds === 30_000));
  assert.deepEqual(f.calls['responses.retrieve'].map(([id]) => id), ['resp_saved', 'resp_saved']);
  assert.equal(count(f, 'responses.create'), 0);
  assert.equal(count(f, 'containers.create'), 0);
  assert.deepEqual(f.calls['store.complete'][0][1].content, pdf);
  await nextTurn();
});
