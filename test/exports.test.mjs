import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createExportRouter, createDownloadRouter } from '../routes/exportRouter.mjs';
import { MAX_MARKDOWN_BYTES } from '../services/openaiExports.mjs';
import { DOWNLOAD_TTL_MS, FILE_RETENTION_MS, signedDownloadUrl, verifyDownload } from '../services/exportDownloads.mjs';

const SECRET = 'unit-test-only-signing-secret';
const NOW = 1793818800000;
const FILE_NAME = 'export-1793818800000-0123456789abcdef.pdf';
const FALLBACK = 'Document generation failed. Please try again.';
const completedJob = overrides => ({ id: 'completed', userId: '1', state: 'completed', format: 'pdf',
  fileName: FILE_NAME, content: Buffer.from('%PDF-1.7\nsynthetic document bytes'),
  completedAt: new Date(NOW).toISOString(), downloadExpiresAt: new Date(NOW + DOWNLOAD_TTL_MS).toISOString(),
  expiresAt: new Date(NOW + FILE_RETENTION_MS).toISOString(), ...overrides });

async function fixture(t) {
  const jobs = new Map();
  const calls = { create: [], status: [], download: [] };
  let now = NOW;
  let downloadOverride;
  const service = {
    async create(input) {
      calls.create.push(input);
      const job = { id: `job-${calls.create.length}`, userId: String(input.userId), format: input.format, state: 'processing' };
      jobs.set(job.id, job); return job;
    },
    async status(id, userId) {
      calls.status.push({ id, userId });
      const job = jobs.get(id);
      return job?.userId === String(userId) ? job : null;
    },
    async findByFileName(fileName) {
      calls.download.push(fileName);
      if (downloadOverride !== undefined) return downloadOverride;
      return [...jobs.values()].find(job => job.fileName === fileName) || null;
    },
  };
  const config = { service, secret: SECRET, now: () => now };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/export/download', createDownloadRouter(config));
  app.use((req, _res, next) => {
    const owner = req.get('x-test-user') || '1';
    if (owner !== 'anonymous') req.user = { user_id: owner };
    next();
  });
  app.use('/api/export', createExportRouter(config));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({
    success: false, code: error.code || 'REQUEST_FAILED',
    message: (error.statusCode < 500 || error.expose) ? error.message : 'The request could not be completed. Please try again.',
  }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  config.backendUrl = base;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = (format, markdownText, headers = {}) => fetch(`${base}/api/export/${format}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ markdownText }),
  });
  const status = (id, owner = '1') => fetch(`${base}/api/export/status/${id}`, { headers: { 'x-test-user': owner } });
  const signed = (job, expiresAt = job.downloadExpiresAt) => signedDownloadUrl({ fileName: job.fileName, expiresAt }, config);
  return { base, jobs, calls, post, status, signed, setNow(value) { now = value; }, overrideDownload(value) { downloadOverride = value; } };
}

test('create validates Markdown and preserves text, ownership, format and idempotency key', async t => {
  const f = await fixture(t);
  const markdown = '# 中文题目\n\n\\(||x||=2\\)\n\n```js\nconst a = "exact";\n```';
  const created = await f.post('PDF', markdown, { 'x-test-user': '7', 'Idempotency-Key': 'client-request-123' });
  assert.equal(created.status, 202);
  const body = await created.json();
  assert.equal(body.success, true); assert.equal(body.jobId, 'job-1');
  assert.deepEqual(f.calls.create[0], { userId: '7', format: 'pdf', markdownText: markdown, requestKey: 'client-request-123' });
  for (const [format, text, expected] of [
    ['txt', 'text', 400], ['pdf', '', 400], ['pdf', '  \n ', 400], ['pdf', {}, 400],
    ['pdf', 'x'.repeat(MAX_MARKDOWN_BYTES + 1), 413],
    ['pdf', '中'.repeat(Math.ceil(MAX_MARKDOWN_BYTES / 3)), 413],
  ]) assert.equal((await f.post(format, text)).status, expected);
  assert.equal(f.calls.create.length, 1);
});

test('unauthenticated requests never dispatch or read an export job', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('pdf', 'synthetic', { 'x-test-user': 'anonymous' })).status, 401);
  assert.equal((await f.status('someone-elses-job', 'anonymous')).status, 404);
  assert.equal(f.calls.create.length, 0); assert.equal(f.calls.status.length, 0);
});

test('status passes the authenticated owner and hides foreign or missing jobs', async t => {
  const f = await fixture(t);
  f.jobs.set('private-job', { id: 'private-job', userId: '7', state: 'processing' });
  const foreign = await f.status('private-job', '8'); const missing = await f.status('missing-job', '8');
  assert.equal(foreign.status, 404); assert.equal(missing.status, 404);
  assert.deepEqual(await foreign.json(), await missing.json());
  const own = await f.status('private-job', '7');
  assert.equal(own.status, 200); assert.equal(own.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await own.json(), { success: true, jobId: 'private-job', state: 'processing', result: null });
  assert.deepEqual(f.calls.status.at(-1), { id: 'private-job', userId: '7' });
});

test('failed status returns allowlisted messages and never raw or inherited error values', async t => {
  const f = await fixture(t);
  const job = { id: 'failed', userId: '1', state: 'failed', errorCode: 'EXPORT_TIMEOUT' };
  f.jobs.set(job.id, job);
  assert.match((await (await f.status(job.id)).json()).message, /timed out.*shorter document/);
  job.errorCode = 'AI_CREDIT_EXHAUSTED';
  assert.match((await (await f.status(job.id)).json()).message, /credits are exhausted/);
  for (const value of ['private homework text and sk-test-secret', 'EXPORT_TIMEOUT\nprivate text', 'toString', 'constructor', '__proto__',
    undefined, null, { message: 'private diagnostic' }, ['EXPORT_TIMEOUT']]) {
    job.errorCode = value;
    const body = await (await f.status(job.id)).json();
    assert.equal(body.state, 'failed'); assert.equal(body.result, null); assert.equal(body.message, FALLBACK);
    assert.doesNotMatch(JSON.stringify(body), /private|sk-test-secret|diagnostic/);
  }
});

test('completed status signs the fixed fifteen-minute deadline, not one-hour retention', async t => {
  const f = await fixture(t);
  const job = completedJob(); f.jobs.set(job.id, job);
  const first = await (await f.status(job.id)).json();
  assert.equal(first.state, 'completed'); assert.equal(first.result.expiresAt, job.downloadExpiresAt);
  assert.notEqual(first.result.expiresAt, job.expiresAt);
  const url = new URL(first.result.downloadUrl);
  assert.equal(Number(url.searchParams.get('expires')), NOW + DOWNLOAD_TTL_MS);
  assert.equal(verifyDownload(job.fileName, url.searchParams.get('expires'), url.searchParams.get('signature'), { secret: SECRET, now: NOW }), true);
  f.setNow(NOW + 60_000);
  const second = await (await f.status(job.id)).json();
  assert.equal(second.result.downloadUrl, first.result.downloadUrl);
  f.setNow(NOW + DOWNLOAD_TTL_MS);
  const expired = await (await f.status(job.id)).json();
  assert.equal(expired.state, 'expired'); assert.equal(expired.result, null); assert.match(expired.message, /expired/);
  assert.equal((await fetch(first.result.downloadUrl)).status, 403);
});

test('signed downloads send the service bytes without requiring a bearer token', async t => {
  const f = await fixture(t);
  for (const format of ['pdf', 'docx']) {
    const bytes = format === 'pdf' ? Buffer.from('%PDF-1.7\nsynthetic PDF') : Buffer.from([80, 75, 3, 4, 1, 2, 3]);
    const job = completedJob({ id: format, format, fileName: FILE_NAME.replace('.pdf', `.${format}`), content: bytes });
    f.jobs.set(job.id, job);
    const response = await fetch(f.signed(job));
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.ok(response.headers.get('content-disposition').includes(job.fileName));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-type'), format === 'pdf' ? /application\/pdf/ : /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
  }
  assert.deepEqual(f.calls.download, [FILE_NAME, FILE_NAME.replace('.pdf', '.docx')]);
});

test('tampered, expired, traversal and duplicate-query capabilities are rejected before reading bytes', async t => {
  const f = await fixture(t);
  const job = completedJob(); f.jobs.set(job.id, job);
  const valid = new URL(f.signed(job));
  const changedTime = new URL(valid); changedTime.searchParams.set('expires', String(NOW + DOWNLOAD_TTL_MS + 1));
  const changedFile = new URL(valid); changedFile.pathname = changedFile.pathname.replace('.pdf', '.docx');
  const badSignature = new URL(valid); badSignature.searchParams.set('signature', 'not-a-signature');
  const duplicateTime = new URL(valid); duplicateTime.searchParams.append('expires', String(NOW + DOWNLOAD_TTL_MS));
  const traversal = `${f.base}/api/export/download/..%2F${FILE_NAME}${valid.search}`;
  for (const url of [changedTime, changedFile, badSignature, duplicateTime, traversal]) assert.equal((await fetch(url)).status, 403);
  f.setNow(NOW + DOWNLOAD_TTL_MS);
  assert.equal((await fetch(valid)).status, 403); assert.equal(f.calls.download.length, 0);
});

test('even a valid signature must match the stored filename and fixed download deadline', async t => {
  const f = await fixture(t);
  const job = completedJob(); f.jobs.set(job.id, job);
  const wrongDeadline = f.signed(job, new Date(NOW + DOWNLOAD_TTL_MS + 1000).toISOString());
  assert.equal((await fetch(wrongDeadline)).status, 404);
  const valid = f.signed(job);
  f.overrideDownload(null); assert.equal((await fetch(valid)).status, 404);
  f.overrideDownload({ ...job, content: null }); assert.equal((await fetch(valid)).status, 404);
  f.overrideDownload({ ...job, downloadExpiresAt: 'invalid' }); assert.equal((await fetch(valid)).status, 404);
  f.overrideDownload({ ...job, fileName: FILE_NAME.replace('.pdf', '.docx'), format: 'docx' });
  assert.equal((await fetch(valid)).status, 404);
});

test('download signatures bind the exact filename, deadline and query scalar types', () => {
  const job = completedJob();
  const url = new URL(signedDownloadUrl({ fileName: FILE_NAME, expiresAt: job.downloadExpiresAt }, { secret: SECRET }));
  const expires = url.searchParams.get('expires'); const signature = url.searchParams.get('signature');
  assert.equal(verifyDownload(FILE_NAME, expires, signature, { secret: SECRET, now: NOW }), true);
  for (const [name, time, sig] of [[`../${FILE_NAME}`, expires, signature], [FILE_NAME, [expires], signature],
    [FILE_NAME, expires, [signature]], [FILE_NAME, expires, '0'.repeat(64)], [FILE_NAME, 'NaN', signature]]) {
    assert.equal(verifyDownload(name, time, sig, { secret: SECRET, now: NOW }), false);
  }
});
