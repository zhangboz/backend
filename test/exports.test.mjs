import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createExportRouter, createDownloadRouter } from '../routes/exportRouter.mjs';
import { exportMarkdown, MAX_MARKDOWN_BYTES, MARKDOWN_READER } from '../FileProcessor/fileExport.mjs';
import {
  DOWNLOAD_TTL_MS, FILE_RETENTION_MS, cleanupExpiredExports, completedExport,
  existingExportPath, signedDownloadUrl, verifyDownload,
} from '../FileProcessor/localExports.mjs';

const SECRET = 'unit-test-only-signing-secret';
const NOW = 1793818800000;
const FILE_NAME = 'export-1793818800000-0123456789abcdef.docx';

async function tempDir(t) {
  const base = path.resolve(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(base, 'hwai-export-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), base);
    assert.ok(path.basename(dir).startsWith('hwai-export-test-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function httpFixture(t, options = {}) {
  const dir = await tempDir(t);
  const jobs = new Map();
  const queue = {
    async add(name, data) {
      const id = String(jobs.size + 1);
      const job = { id, data, state: 'waiting', async getState() { return this.state; } };
      jobs.set(id, job);
      return job;
    },
    async getJob(id) { return jobs.get(id); },
  };
  let now = NOW;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const config = { exportDir: dir, secret: SECRET, now: () => now, ...options };
  app.use('/api/export/download', createDownloadRouter(config));
  app.use((req, res, next) => { req.user = { user_id: req.get('x-test-user') || '1' }; next(); });
  // backendUrl is assigned after listen, before a request can be sent.
  app.use('/api/export', createExportRouter({ ...config, queueProvider: async () => queue }));
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { dir, jobs, base, setNow: (value) => { now = value; } };
}

test('download signatures bind the filename and deadline and reject traversal', () => {
  const result = completedExport(FILE_NAME, NOW);
  const url = new URL(signedDownloadUrl(result, { secret: SECRET }));
  const expires = url.searchParams.get('expires');
  const signature = url.searchParams.get('signature');
  assert.equal(Date.parse(result.expiresAt), NOW + DOWNLOAD_TTL_MS);
  assert.equal(verifyDownload(FILE_NAME, expires, signature, { secret: SECRET, now: NOW }), true);
  assert.equal(verifyDownload(FILE_NAME, expires, signature, { secret: SECRET, now: Number(expires) }), false);
  assert.equal(verifyDownload(FILE_NAME, String(Number(expires) + 1), signature, { secret: SECRET, now: NOW }), false);
  assert.equal(verifyDownload(FILE_NAME.replace('.docx', '.pdf'), expires, signature, { secret: SECRET, now: NOW }), false);
  assert.equal(verifyDownload('../' + FILE_NAME, expires, signature, { secret: SECRET, now: NOW }), false);
  assert.equal(verifyDownload(FILE_NAME, expires, 'invalid', { secret: SECRET, now: NOW }), false);
  assert.equal(verifyDownload(FILE_NAME, [expires], signature, { secret: SECRET, now: NOW }), false);
});

test('enqueue validates content and attaches ownership; status hides other users and legacy jobs', async (t) => {
  const { base, jobs } = await httpFixture(t);
  const response = await fetch(base + '/api/export/docx', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': '7' },
    body: JSON.stringify({ markdownText: '$||x||=2$' }),
  });
  assert.equal(response.status, 202);
  const { jobId } = await response.json();
  assert.deepEqual(jobs.get(jobId).data, { markdownText: '$||x||=2$', targetFormat: 'docx', userId: '7' });
  assert.equal((await fetch(base + '/api/export/status/' + jobId, { headers: { 'x-test-user': '8' } })).status, 404);
  const own = await fetch(base + '/api/export/status/' + jobId, { headers: { 'x-test-user': '7' } });
  assert.equal((await own.json()).state, 'waiting');
  delete jobs.get(jobId).data.userId;
  assert.equal((await fetch(base + '/api/export/status/' + jobId, { headers: { 'x-test-user': '7' } })).status, 404);
  for (const [format, markdownText, expected] of [
    ['txt', 'text', 400], ['pdf', '', 400], ['pdf', {}, 400],
    ['pdf', 'x'.repeat(MAX_MARKDOWN_BYTES + 1), 413],
  ]) {
    const result = await fetch(base + '/api/export/' + format, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ markdownText }),
    });
    assert.equal(result.status, expected);
  }
  assert.equal(jobs.size, 1);
});

test('failed status explains known converter errors and never returns arbitrary historical diagnostics', async (t) => {
  const { base, jobs, dir } = await httpFixture(t);
  // Carry a real classified converter failure through the HTTP status route,
  // as BullMQ does when persisting Error.message as failedReason.
  let mathFailure;
  try {
    await exportMarkdown('private homework text', 'pdf', {
      outputDir: dir,
      spawnProcess: fakeConverter(() => {}, { code: 43,
        stderr: 'Error producing PDF.\n! Missing $ inserted.\nl.135 private homework text',
      }),
    });
    assert.fail('Expected the synthetic converter to fail');
  } catch (error) {
    assert.equal(error.code, 'EXPORT_LATEX_SYNTAX');
    mathFailure = error.message;
  }
  const failedJob = { id: 'failed', data: { userId: 1 }, failedReason: mathFailure,
    async getState() { return 'failed'; } };
  jobs.set('failed', failedJob);
  async function statusFor(reason) {
    failedJob.failedReason = reason;
    const response = await fetch(base + '/api/export/status/failed');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.state, 'failed');
    assert.equal(body.result, null);
    return body;
  }
  const math = await statusFor(mathFailure);
  assert.match(math.message, /mathematical formatting/);
  assert.match(math.message, /Word/);
  assert.doesNotMatch(JSON.stringify(math), /private homework|l\.135/);
  const timeout = await statusFor('Document conversion timed out. Please try a shorter document.');
  assert.match(timeout.message, /timed out.*shorter document/);
  const missingPandoc = await statusFor('Pandoc is not installed or is not on PATH.');
  assert.match(missingPandoc.message, /requires Pandoc/);
  const embeddedImage = await statusFor('Embedded images are not supported in document exports.');
  assert.match(embeddedImage.message, /does not support embedded images.*Remove the image/);

  const fallback = 'Document conversion failed. Please try again or choose another export format.';
  for (const reason of [
    'Document conversion failed (exit code 43).',
    'Raw XeLaTeX diagnostic: private homework text',
    mathFailure + '\nprivate homework text',
    'toString', undefined, { message: mathFailure },
  ]) {
    const body = await statusFor(reason);
    assert.equal(body.message, fallback);
    assert.doesNotMatch(JSON.stringify(body), /private homework|Raw XeLaTeX/);
  }
  assert.equal((await fetch(base + '/api/export/status/failed', {
    headers: { 'x-test-user': '2' },
  })).status, 404);
});

test('completed jobs expose a fixed deadline and signed downloads need no bearer token', async (t) => {
  const { base, dir, jobs, setNow } = await httpFixture(t);
  const result = completedExport(FILE_NAME, NOW);
  await fs.writeFile(path.join(dir, FILE_NAME), 'synthetic document');
  jobs.set('9', { id: '9', data: { userId: 1 }, returnvalue: result, async getState() { return 'completed'; } });
  const first = await (await fetch(base + '/api/export/status/9')).json();
  assert.equal(first.state, 'completed');
  assert.equal(first.result.expiresAt, result.expiresAt);
  setNow(NOW + 60000);
  const second = await (await fetch(base + '/api/export/status/9')).json();
  assert.equal(second.result.downloadUrl, first.result.downloadUrl);
  const url = new URL(first.result.downloadUrl);
  const downloaded = await fetch(base + url.pathname + url.search);
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), 'synthetic document');
  assert.match(downloaded.headers.get('content-disposition'), /^attachment;/);
  assert.equal(downloaded.headers.get('cache-control'), 'private, no-store');
  url.searchParams.set('expires', String(NOW + DOWNLOAD_TTL_MS + 1));
  assert.equal((await fetch(base + url.pathname + url.search)).status, 403);
  setNow(NOW + DOWNLOAD_TTL_MS);
  const expired = await (await fetch(base + '/api/export/status/9')).json();
  assert.equal(expired.state, 'expired');
  assert.equal(expired.result, null);
});

test('cleanup deletes only expired generated files and path access rejects unrelated files', async (t) => {
  const dir = await tempDir(t);
  const recent = FILE_NAME.replace('0123456789abcdef', 'fedcba9876543210');
  const unrelated = 'keep-notes.txt';
  await Promise.all([FILE_NAME, recent, unrelated].map((name) => fs.writeFile(path.join(dir, name), 'synthetic')));
  const old = new Date(NOW - FILE_RETENTION_MS - 1);
  await fs.utimes(path.join(dir, FILE_NAME), old, old);
  await fs.utimes(path.join(dir, unrelated), old, old);
  await fs.utimes(path.join(dir, recent), new Date(NOW), new Date(NOW));
  assert.equal(await cleanupExpiredExports({ exportDir: dir, now: NOW }), 1);
  assert.deepEqual((await fs.readdir(dir)).sort(), [recent, unrelated].sort());
  assert.equal(await existingExportPath('../' + recent, dir), null);
  assert.equal(await existingExportPath(unrelated, dir), null);
  assert.equal(await existingExportPath(recent, dir), path.join(dir, recent));
});

function fakeConverter(onInput, { code = 0, stderr = '', neverExit = false } = {}) {
  return (executable, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; child.emit('close', null); return true; };
    let input = '';
    child.stdin.on('data', (chunk) => { input += chunk; });
    child.stdin.on('finish', () => {
      onInput({ executable, args, spawnOptions, input, child });
      if (code === 0 && !neverExit) writeFileSync(args[args.indexOf('-o') + 1], 'synthetic output');
      if (stderr) child.stderr.write(stderr);
      if (!neverExit) child.emit('close', code);
    });
    return child;
  };
}

test('converter preserves math and uses argument arrays with an explicit CJK font', async (t) => {
  const dir = await tempDir(t);
  const markdown = '中文 $||x||$\n\n```js\na || b\n```';
  let observed;
  await exportMarkdown(markdown, 'pdf', {
    outputDir: dir, cjkFont: 'Microsoft YaHei', spawnProcess: fakeConverter((input) => { observed = input; }),
  });
  assert.equal(observed.input, markdown);
  assert.equal(observed.args[observed.args.indexOf('-f') + 1], MARKDOWN_READER);
  assert.equal(observed.spawnOptions.shell, false);
  assert.ok(observed.args.includes('--sandbox'));
  assert.ok(observed.args.includes('--fail-if-warnings'));
  assert.ok(observed.args.includes('--pdf-engine-opt=-no-shell-escape'));
  assert.notEqual(observed.spawnOptions.cwd, process.cwd());
  assert.equal(observed.spawnOptions.env.HOME, observed.spawnOptions.cwd);
  assert.equal(observed.spawnOptions.env.TMPDIR, observed.spawnOptions.cwd);
  assert.equal(observed.spawnOptions.env.shell_escape, 'f');
  assert.equal(observed.spawnOptions.env.OPENAI_API_KEY, undefined);
  assert.equal(observed.spawnOptions.env.DB_PASSWORD, undefined);
  await assert.rejects(fs.stat(observed.spawnOptions.cwd), { code: 'ENOENT' });
  assert.ok(observed.args.includes('CJKmainfont=Microsoft YaHei'));
  assert.ok(observed.args.includes('--pdf-engine=xelatex'));
});

test('converter removes partial files and does not expose document text in errors', async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(exportMarkdown('private text', 'docx', {
    outputDir: dir,
    spawnProcess: fakeConverter(({ args }) => writeFileSync(args[args.indexOf('-o') + 1], 'partial'), {
      code: 9, stderr: 'private text in diagnostic',
    }),
  }), (error) => error.message.includes('exit code 9') && !error.message.includes('private text'));
  assert.deepEqual(await fs.readdir(dir), []);
  let child;
  await assert.rejects(exportMarkdown('synthetic', 'pdf', {
    outputDir: dir, timeoutMs: 15,
    spawnProcess: fakeConverter((input) => { child = input.child; }, { neverExit: true }),
  }), /timed out/);
  assert.equal(child.killed, true);
});

test('converter classifies TeX errors without exposing source or raw diagnostics', async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(exportMarkdown('private homework text', 'pdf', {
    outputDir: dir,
    spawnProcess: fakeConverter(() => {}, { code: 43,
      stderr: 'Error producing PDF.\n! Missing $ inserted.\nl.135 private homework text',
    }),
  }), error => error.code === 'EXPORT_LATEX_SYNTAX' && error.exitCode === 43 &&
    !error.message.includes('private') && !error.message.includes('l.135'));
});

test('native Pandoc parses OpenAI backslash math while preserving code literals', {
  skip: process.env.RUN_EXPORT_INTEGRATION !== '1', timeout: 180000,
}, async (t) => {
  const dir = await tempDir(t);
  const markdown = [
    '# Math delimiter regression', '',
    String.raw`**\(\displaystyle x=2\)** and \(a+b=3\), alongside $y=4$.`, '',
    String.raw`\[\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}\]`, '',
    'Literal code: `' + String.raw`\(not math\)` + '`.', '',
    '```text', String.raw`\[not math\]`, '```', '',
  ].join('\n');
  const parsed = spawnSync('pandoc', ['-f', MARKDOWN_READER, '-t', 'json'], {
    input: markdown, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(parsed.status, 0);
  const math = []; const code = [];
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    if (value.t === 'Math') math.push(value.c);
    if (value.t === 'Code' || value.t === 'CodeBlock') code.push(value.c[1]);
    for (const child of Object.values(value)) inspect(child);
  }
  inspect(JSON.parse(parsed.stdout));
  assert.equal(math.length, 4);
  assert.ok(code.includes(String.raw`\(not math\)`));
  assert.ok(code.includes(String.raw`\[not math\]`));
  for (const format of ['docx', 'pdf']) {
    const file = await exportMarkdown(markdown, format, { outputDir: dir });
    const bytes = await fs.readFile(file);
    assert.equal(bytes.subarray(0, format === 'pdf' ? 5 : 2).toString(), format === 'pdf' ? '%PDF-' : 'PK');
  }
});

test('real Pandoc exports Chinese, math, tables, code and norms to DOCX and PDF', {
  skip: process.env.RUN_EXPORT_INTEGRATION !== '1', timeout: 180000,
}, async (t) => {
  const dir = await tempDir(t);
  const markdown = '# 中文数学测试 / Math test\n\n求解 Solve $2x+3=7$, so $x=2$. Norm: $\\lVert x\\rVert=2$.\n\n' +
    '| 项目 | Value |\n| --- | --- |\n| 答案 | 2 |\n\n```js\nconst answer = a || b;\n```\n';
  for (const format of ['docx', 'pdf']) {
    const output = await exportMarkdown(markdown, format, { outputDir: dir });
    const bytes = await fs.readFile(output);
    assert.ok(bytes.length > 1000);
    assert.equal(bytes.subarray(0, format === 'pdf' ? 5 : 2).toString(), format === 'pdf' ? '%PDF-' : 'PK');
    if (format === 'docx') {
      const plain = spawnSync('pandoc', [output, '-t', 'plain'], { encoding: 'utf8', windowsHide: true });
      assert.equal(plain.status, 0);
      assert.match(plain.stdout, /中文数学测试/);
      assert.match(plain.stdout, /a \|\| b/);
    } else {
      const plain = spawnSync('pdftotext', ['-layout', output, '-'], { encoding: 'utf8', windowsHide: true });
      if (plain.error?.code === 'ENOENT') {
        t.diagnostic('Poppler is optional; PDF structure checked, text extraction skipped.');
      } else {
        assert.equal(plain.status, 0);
        assert.match(plain.stdout, /中文数学测试/);
        assert.match(plain.stdout, /a \|\| b/);
        assert.match(plain.stdout.normalize('NFKC'), /2x\s*\+\s*3\s*=\s*7/);
      }
    }
  }
});

test('native Pandoc sandbox rejects filesystem and network image resources', {
  skip: process.env.RUN_EXPORT_INTEGRATION !== '1', timeout: 180000,
}, async t => {
  const dir = await tempDir(t);
  const canary = path.join(dir, 'other-user-secret.svg');
  await fs.writeFile(canary, '<svg xmlns="http://www.w3.org/2000/svg"><text>OTHER_USER_CANARY</text></svg>');
  let requests = 0;
  const app = express();
  app.get('/private.svg', (_req, res) => { requests++; res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg"/>'); });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  for (const resource of [pathToFileURL(canary).href, 'http://127.0.0.1:' + server.address().port + '/private.svg']) {
    for (const format of ['docx', 'pdf']) {
      await assert.rejects(exportMarkdown('![External resource](<' + resource + '>)', format, { outputDir: dir }),
        error => error.code === 'EXPORT_EXTERNAL_RESOURCE_BLOCKED' && !error.message.includes('OTHER_USER_CANARY'));
    }
  }
  assert.equal(requests, 0);
  assert.deepEqual(await fs.readdir(dir), ['other-user-secret.svg']);
});

test('Linux conversion timeout kills the Pandoc and TeX process group', {
  skip: process.env.RUN_EXPORT_INTEGRATION !== '1' || process.platform === 'win32', timeout: 15000,
}, async t => {
  const dir = await tempDir(t);
  let pid;
  await assert.rejects(exportMarkdown(String.raw`\loop\iftrue\repeat`, 'pdf', {
    outputDir: dir, timeoutMs: 1500,
    spawnProcess(executable, args, options) {
      const child = spawn(executable, args, options); pid = child.pid; return child;
    },
  }), error => error.code === 'EXPORT_TIMEOUT');
  assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await fs.readdir(dir), []);
});
