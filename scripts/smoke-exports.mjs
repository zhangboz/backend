import '../config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import db from '../db.mjs';

// Uses the previously authorized local TEST fixture and synthetic content only.
// No new users, Stripe calls, email, production data or secret-bearing output.
if (!process.argv.includes('--live')) {
  console.log('Usage: node scripts/smoke-exports.mjs --live (two paid OpenAI document generations)');
  process.exit(0);
}
const base = new URL(process.env.BACKEND_URL || 'http://localhost:5000');
assert(['localhost', '127.0.0.1'].includes(base.hostname), 'Local API only.');
assert(['localhost', '127.0.0.1'].includes(process.env.DB_HOST), 'Local database only.');
const directory = new URL('../.local/smoke-openai-exports/', import.meta.url);
await fs.mkdir(directory, { recursive: true });
const registry = JSON.parse(await fs.readFile(new URL('../.local/test-accounts.json', import.meta.url), 'utf8'));
const account = registry.accounts.find(item => item.purpose === 'local seven-day demo trial');
assert(account && /@example\.invalid$/.test(account.email), 'Existing synthetic trial fixture required.');
const markdown = String.raw`# 中英文导出测试 / Export check

题目：计算函数的导数，并保留符号。

For \(f(x)=x^2\), the derivative is \(f'(x)=2x\).

\[\|x\| = \sqrt{x_1^2+x_2^2},\qquad \int_0^1 x\,dx=\frac{1}{2}\]

| 项目 | Value |
| --- | --- |
| 答案 | 2x |
| 中文 | 完整保留 |

` + '```js\nconst label = "中文";\nconst valid = left || right;\n```\n';
const report = { passed: false, model: 'gpt-6.1-terra', checks: [] };
let token;
async function request(route, { method = 'GET', body, headers = {} } = {}) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { response = await fetch(new URL(route, base), { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90_000) }); break;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  const data = await response.json();
  assert(response.ok, `HTTP ${response.status}: ${data.code || 'request_failed'}`);
  return data;
}
try {
  token = (await request('/api/login/login', { method: 'POST', body: { email: account.email, password: account.password } })).token;
  assert(token, 'Local fixture login failed.');
  for (const format of ['pdf', 'docx']) {
    const started = Date.now();
    const key = randomUUID();
    const create = () => request('/api/export/' + format, { method: 'POST',
      body: { markdownText: markdown }, headers: { 'Idempotency-Key': key } });
    const resumeId = format === 'pdf' ? process.argv.find(arg => arg.startsWith('--resume-job='))?.slice(13) : null;
    const job = resumeId ? { jobId: resumeId } : await create();
    if (!resumeId) assert.equal((await create()).jobId, job.jobId, 'Duplicate creation must reuse the same job.');
    console.log(JSON.stringify({ stage: 'submitted', format, duplicateReused: true }));
    if (format === 'pdf') {
      const restart = spawnSync(process.execPath, ['scripts/local.mjs', 'restart-api'], {
        cwd: new URL('..', import.meta.url), windowsHide: true, encoding: 'utf8', timeout: 60_000,
      });
      assert.equal(restart.status, 0, 'API restart failed.');
      console.log(JSON.stringify({ stage: 'restarted-api', pendingJobPersisted: true }));
    }
    let status;
    while (Date.now() - started < 8 * 60_000) {
      status = await request('/api/export/status/' + job.jobId);
      if (['completed', 'failed', 'expired'].includes(status.state)) break;
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
    assert.equal(status.state, 'completed', `Export failed: ${status.message || status.state}`);
    const download = new URL(status.result.downloadUrl);
    assert.equal(download.origin, base.origin);
    const response = await fetch(download, { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length > 100 && bytes.length <= 8 * 1024 * 1024);
    assert.equal(bytes.subarray(0, format === 'pdf' ? 5 : 2).toString(), format === 'pdf' ? '%PDF-' : 'PK');
    await fs.writeFile(new URL(`export.${format}`, directory), bytes);
    const persisted = await db.query('SELECT state, octet_length(content)::int AS bytes FROM export_jobs WHERE id = $1 AND user_id = $2', [job.jobId, String(account.id)]);
    assert.equal(persisted.rows[0].bytes, bytes.length);
    download.searchParams.set('signature', '0'.repeat(64));
    assert.equal((await fetch(download)).status, 403);
    const result = { format, elapsedMs: Date.now() - started, bytes: bytes.length, restartTest: format === 'pdf' };
    report.checks.push(result);
    console.log(JSON.stringify({ stage: 'passed', ...result }));
  }
  report.passed = true;
} catch (error) {
  // Assertion messages above are authored locally and never include credentials.
  console.error('Export smoke failed:', error.code || error.name);
  report.error = { code: error.code, name: error.name, message: error.message, stack: error.stack?.split('\n').slice(0, 4) };
  process.exitCode = 1;
} finally {
  await fs.writeFile(new URL('report.json', directory), JSON.stringify(report, null, 2));
  await db.end();
}
