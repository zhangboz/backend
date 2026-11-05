import test from 'node:test';
import assert from 'node:assert/strict';
import { createExportJobStore } from '../services/exportJobStore.mjs';
const NOW = Date.parse('2026-11-04T20:00:00.000Z');
const ID = '0b4b0f76-9696-4cb4-90bc-c2395056fb49';
const TOKEN = '0b4b0f76-9696-4cb4-90bc-c2395056fb50';
const FILE = 'export-1793822400000-0123456789abcdef.pdf';
const row = overrides => ({ id: ID, user_id: '42', format: 'pdf', state: 'processing', response_id: 'resp_fixture',
  source_file_id: 'cfile_fixture', container_id: 'cntr_fixture', provider_file_id: null, filename: null, error_code: null,
  request_key: 'request-fixture', created_at: new Date(NOW - 1000), updated_at: new Date(NOW - 1000),
  completed_at: null, expires_at: new Date(NOW + 600_000), download_expires_at: null, poll_after: null, poll_token: TOKEN, ...overrides });

// These boundary tests use synthetic rows. The real PostgreSQL SQL must also be
// checked against a test DB after a database backup and migration.
function fixture(handler, options = {}) {
  const calls = [];
  let released = 0;
  const client = { async query(sql, values = []) {
    const call = { sql: sql.replace(/\s+/g, ' ').trim(), values }; calls.push(call);
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call.sql) || call.sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    return await handler(call) ?? { rows: [] };
  }, release() { released++; } };
  const db = { query: (...args) => client.query(...args), getClient: async () => client };
  return { store: createExportJobStore({ db, now: () => NOW, ...options }), calls, released: () => released };
}
const admission = counts => call => {
  if (call.sql.includes('AS global_pending')) return { rows: [{ global_pending: '0', user_pending: '0', user_daily: '0', ...counts }] };
  if (call.sql.startsWith('INSERT INTO')) return { rows: [row({ state: 'starting', response_id: null, poll_token: null })] };
};

test('idempotent replay returns existing owner job without quota consumption or dispatch', async () => {
  const f = fixture(call => call.sql.includes('WHERE user_id = $1 AND request_key = $2') ? { rows: [row()] } : undefined);
  const job = await f.store.create({ userId: 42, format: 'pdf', requestKey: 'request-fixture' });
  assert.equal(job.created, false); assert.equal(job.id, ID); assert.equal(job.userId, '42');
  assert.equal(f.calls.some(call => call.sql.startsWith('INSERT INTO') || call.sql.includes('AS global_pending')), false);
  assert.deepEqual(f.calls.find(call => call.sql.includes('request_key = $2')).values, ['42', 'request-fixture']);
  assert.equal(f.calls.at(-1).sql, 'COMMIT'); assert.equal(f.released(), 1);
});

test('request-key replay cannot silently change format', async () => {
  const f = fixture(call => call.sql.includes('request_key = $2') ? { rows: [row({ format: 'docx' })] } : undefined);
  await assert.rejects(f.store.create({ userId: 42, format: 'pdf', requestKey: 'request-fixture' }), { code: 'EXPORT_REQUEST_CONFLICT', statusCode: 409 });
  assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
});

test('admission locks quotas atomically and assigns a ten-minute deadline', async () => {
  const f = fixture(admission());
  const job = await f.store.create({ id: ID, userId: 42, format: 'pdf' });
  assert.equal(job.created, true); assert.equal(f.calls[0].sql, 'BEGIN'); assert.match(f.calls[1].sql, /pg_advisory_xact_lock/);
  const insert = f.calls.find(call => call.sql.startsWith('INSERT INTO'));
  assert.equal(insert.values[0], ID); assert.equal(insert.values[1], '42'); assert.equal(insert.values[5].getTime(), NOW + 600_000);
  assert.equal(f.calls.at(-1).sql, 'COMMIT');
});

test('user, global, and rolling daily quotas reject jobs and roll back', async () => {
  for (const [counts, code] of [[{ user_pending: '2' }, 'EXPORT_BUSY'], [{ global_pending: '8' }, 'EXPORT_BUSY'], [{ user_daily: '30' }, 'EXPORT_DAILY_LIMIT']]) {
    const f = fixture(admission(counts));
    await assert.rejects(f.store.create({ userId: 42, format: 'pdf' }), { code, statusCode: 429 });
    assert.equal(f.calls.some(call => call.sql.startsWith('INSERT INTO')), false); assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(f.calls.find(call => call.sql.includes('AS global_pending')).values[1].getTime(), NOW - 86_400_000);
    assert.equal(f.released(), 1);
  }
});

test('database errors never expose credentials or diagnostics', async () => {
  const f = fixture(() => { throw new Error('postgres://private:test-secret@example.invalid'); });
  await assert.rejects(f.store.create({ userId: 42, format: 'pdf' }), error => {
    assert.equal(error.code, 'EXPORT_STORE_UNAVAILABLE'); assert.equal(error.statusCode, 503);
    assert.doesNotMatch(error.message, /test-secret|postgres:/); return true;
  });
  assert.equal(f.calls.at(-1).sql, 'ROLLBACK'); assert.equal(f.released(), 1);
});

test('owner lookup parameterizes ownership and never reads binary content', async () => {
  const f = fixture(() => ({ rows: [] }));
  assert.equal(await f.store.getOwned('../secret', 42), null); assert.equal(f.calls.length, 0);
  assert.equal(await f.store.getOwned(ID, 'other-owner'), null);
  assert.deepEqual(f.calls[0].values, [ID, 'other-owner']); assert.match(f.calls[0].sql, /WHERE id = \$1 AND user_id = \$2/);
  assert.doesNotMatch(f.calls[0].sql, /\bcontent\b/);
});

test('container IDs persist before response creation without forcing processing', async () => {
  const f = fixture(() => ({ rows: [row({ state: 'starting', response_id: null })] }));
  assert.equal((await f.store.setProvider(ID, { containerId: 'cntr_fixture' })).state, 'starting');
  assert.deepEqual(f.calls[0].values.slice(0, 4), [ID, null, null, 'cntr_fixture']);
  assert.match(f.calls[0].sql, /CASE WHEN COALESCE\(\$2, response_id\) IS NULL THEN 'starting' ELSE 'processing' END/);
});

test('atomic poll claims require a response, unexpired job, and expired prior lease', async () => {
  const f = fixture(() => ({ rows: [] }));
  assert.equal(await f.store.claimPoll(ID), null);
  assert.match(f.calls[0].sql, /state = 'processing' AND response_id IS NOT NULL AND expires_at > \$4/);
  assert.match(f.calls[0].sql, /poll_after IS NULL OR poll_after <= \$4/);
  assert.equal(f.calls[0].values[2].getTime(), NOW + 60_000); assert.notEqual(f.calls[0].values[1], TOKEN);
  await assert.rejects(f.store.claimPoll(ID, { leaseMs: 0 }), { code: 'INVALID_EXPORT_LEASE' });
});

test('stale poll tokens cannot complete or fail another lease', async () => {
  const f = fixture(() => ({ rows: [] }));
  assert.equal(await f.store.complete(ID, { content: Buffer.from('%PDF-fixture'), fileName: FILE, pollToken: TOKEN }), null);
  assert.equal(f.calls.some(call => call.sql.includes("SET state = 'completed'")), false);
  assert.match(f.calls.find(call => call.sql.includes('FOR UPDATE')).sql, /poll_token = \$2/);
  assert.equal(await f.store.fail(ID, { errorCode: 'AI_TIMEOUT', pollToken: TOKEN }), null);
  assert.match(f.calls.at(-1).sql, /poll_token = \$4/);
  await assert.rejects(f.store.complete(ID, { content: Buffer.from('%PDF-fixture'), fileName: FILE }), { code: 'EXPORT_LEASE_REQUIRED' });
});

test('per-file and global storage quotas refuse binary writes', async () => {
  const tooLarge = fixture(() => { throw new Error('must not query'); }, { maxFileBytes: 4 });
  await assert.rejects(tooLarge.store.complete(ID, { content: Buffer.alloc(5), fileName: FILE, pollToken: TOKEN }), { code: 'EXPORT_TOO_LARGE' });
  assert.equal(tooLarge.calls.length, 0);
  const full = fixture(call => {
    if (call.sql.includes('FOR UPDATE')) return { rows: [row()] };
    if (call.sql.includes('AS stored_bytes')) return { rows: [{ stored_bytes: '8' }] };
  }, { maxStoredBytes: 10 });
  await assert.rejects(full.store.complete(ID, { content: Buffer.from('abc'), fileName: FILE, pollToken: TOKEN }), { code: 'EXPORT_STORAGE_FULL' });
  assert.equal(full.calls.some(call => call.sql.includes("SET state = 'completed'")), false); assert.equal(full.calls.at(-1).sql, 'ROLLBACK');
});

test('completed downloads expire in fifteen minutes and binary storage in one hour', async () => {
  const f = fixture(call => {
    if (call.sql.includes('FOR UPDATE')) return { rows: [row()] };
    if (call.sql.includes('AS stored_bytes')) return { rows: [{ stored_bytes: '0' }] };
    if (call.sql.includes("SET state = 'completed'")) return { rows: [row({ state: 'completed', filename: FILE,
      completed_at: call.values[5], expires_at: call.values[6], download_expires_at: call.values[7], poll_token: null })] };
  });
  const job = await f.store.complete(ID, { content: Buffer.from('%PDF-fixture'), fileName: FILE, pollToken: TOKEN });
  assert.equal(job.state, 'completed'); assert.equal(job.downloadExpiresAt, new Date(NOW + 900_000).toISOString());
  assert.equal(job.expiresAt, new Date(NOW + 3_600_000).toISOString()); assert.equal(Object.hasOwn(job, 'content'), false);
  const write = f.calls.find(call => call.sql.includes("SET state = 'completed'"));
  assert.equal(write.values[1].toString(), '%PDF-fixture'); assert.equal(write.values[8], TOKEN);
});

test('expired downloads and path-like filenames never yield document bytes', async () => {
  const f = fixture(() => ({ rows: [] }));
  assert.equal(await f.store.findByFileName('../../private.pdf'), null); assert.equal(f.calls.length, 0);
  assert.equal(await f.store.findByFileName(FILE), null);
  assert.match(f.calls[0].sql, /download_expires_at > \$2/); assert.match(f.calls[0].sql, /expires_at > \$2 AND content IS NOT NULL/);
  assert.equal(f.calls[0].values[1].getTime(), NOW);
});

test('cleanup drops expired bytes, retries provider cleanup, and prunes only cleared old metadata', async () => {
  const f = fixture(call => call.sql.startsWith('SELECT id,') ? { rows: [row({ state: 'expired' })] } : undefined);
  const jobs = await f.store.cleanup(); assert.equal(jobs[0].containerId, 'cntr_fixture');
  const expire = f.calls.find(call => call.sql.startsWith('UPDATE'));
  assert.match(expire.sql, /state = 'expired', content = NULL/); assert.match(expire.sql, /expires_at <= \$1/);
  assert.doesNotMatch(expire.sql, /container_id = NULL/);
  const prune = f.calls.find(call => call.sql.startsWith('DELETE'));
  assert.match(prune.sql, /content IS NULL AND response_id IS NULL AND source_file_id IS NULL/);
  assert.equal(prune.values[0].getTime(), NOW - 7 * 86_400_000);
  assert.match(f.calls.find(call => call.sql.startsWith('SELECT id,')).sql, /LIMIT 32/);
  await f.store.clearProvider(ID);
  assert.match(f.calls.at(-1).sql, /response_id = NULL, source_file_id = NULL/);
  assert.match(f.calls.at(-1).sql, /state IN \('completed', 'failed', 'expired'\)/);
});
