import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Opt-in, offline integration checks. All writes are restricted to a fresh,
// random schema. Never applies old migrations or writes public application data.
if (!process.argv.slice(2).includes('--live-local')) {
  console.log('Usage: node scripts/smoke-cloud-runtime.mjs --live-local');
  console.log('Uses only 127.0.0.1 PostgreSQL, synthetic rows in a temporary schema, and no external APIs.');
  process.exit(0);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const reportFile = path.join(root, '.local', 'smoke-cloud-runtime-report.json');
const report = { startedAt: new Date().toISOString(), passed: false, schemaDropped: false,
  historicalRowsUnchanged: false, checks: [] };
let step = 'preflight';
let schemaCreated = false;
let admin;
let pool;
let before;
let failure;
const schema = `test_cloud_runtime_${randomBytes(12).toString('hex')}`;
const check = name => { report.checks.push(name); console.log(JSON.stringify({ check: name, passed: true })); };
const schemaValid = () => /^test_cloud_runtime_[a-f0-9]{24}$/.test(schema);

async function fingerprints(client) {
  const result = {};
  // Fingerprints are calculated inside PostgreSQL; no user rows, credentials,
  // email addresses, password hashes, or subscription data leave the database.
  for (const table of ['users', 'subscriptions']) {
    const { rows } = await client.query(`SELECT count(*)::int AS count,
      md5(COALESCE(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text), '')) AS fingerprint
      FROM public.${table} AS t`);
    result[table] = rows[0];
  }
  return result;
}

try {
  const { loadLocalEnvironment } = await import('../services/runtimeConfig.mjs');
  loadLocalEnvironment(root);
  assert.notEqual(process.env.NODE_ENV, 'production', 'This smoke test is local only.');
  let connection;
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    assert(['postgres:', 'postgresql:'].includes(url.protocol), 'A PostgreSQL URL is required.');
    assert.equal(url.hostname, '127.0.0.1', 'DATABASE_URL must point to 127.0.0.1.');
    // Build explicit fields, ignoring URL options which could override the host
    // or search_path. No connection string or credential is printed or stored.
    connection = { host: '127.0.0.1', port: Number(url.port || 5432), user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)) };
  } else {
    assert.equal(process.env.DB_HOST, '127.0.0.1', 'DB_HOST must be 127.0.0.1.');
    connection = { host: '127.0.0.1', port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER,
      password: process.env.DB_PASSWORD, database: process.env.DB_NAME };
  }
  assert(connection.database && connection.user, 'Explicit local database and user are required.');
  assert(Number.isInteger(connection.port) && connection.port > 0 && connection.port <= 65535, 'Invalid local database port.');
  assert(schemaValid(), 'Invalid isolated schema name.');
  const migration = await fs.readFile(path.join(root, 'migrations', '20261104_cloud_runtime.sql'), 'utf8');
  const statements = migration.replace(/^\uFEFF/, '').replace(/--[^\r\n]*/g, '').split(';').map(value => value.trim()).filter(Boolean);
  const allowed = [
    /^CREATE TABLE IF NOT EXISTS oauth_sessions\s*\(/,
    /^CREATE INDEX IF NOT EXISTS oauth_sessions_expires_at_idx ON oauth_sessions\s*\(/,
    /^CREATE TABLE IF NOT EXISTS export_jobs\s*\(/,
    /^CREATE INDEX IF NOT EXISTS export_jobs_owner_created_idx ON export_jobs\s*\(/,
    /^CREATE INDEX IF NOT EXISTS export_jobs_expiration_idx ON export_jobs\s*\(/,
    /^CREATE INDEX IF NOT EXISTS export_jobs_pending_idx ON export_jobs\s*\(/,
  ];
  assert.equal(statements.length, allowed.length, 'Unexpected migration statements.');
  for (let index = 0; index < statements.length; index++) {
    assert.match(statements[index], allowed[index], 'Only the cloud runtime table/index migration is allowed.');
    assert(!/\b(public|pg_catalog)\s*\./i.test(statements[index]), 'Migration must not target another schema.');
  }
  const backups = await fs.readdir(path.join(root, 'backups'));
  assert((await Promise.all(backups.filter(name => name.endsWith('.dump')).map(name => fs.stat(path.join(root, 'backups', name)))))
    .some(stat => stat.size > 0), 'Create a local database backup before running this test.');
  admin = new pg.Client({ ...connection, ssl: false, application_name: 'synapse-cloud-runtime-smoke-guard',
    connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  await admin.connect();
  assert.equal((await admin.query('SELECT host(inet_server_addr()) AS address')).rows[0].address, '127.0.0.1');
  before = await fingerprints(admin);
  report.initialCounts = Object.fromEntries(Object.entries(before).map(([table, value]) => [table, value.count]));
  report.databaseBytesBefore = Number((await admin.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  pool = new pg.Pool({ ...connection, ssl: false, max: 12, idleTimeoutMillis: 1000, connectionTimeoutMillis: 5000,
    statement_timeout: 15000, application_name: 'synapse-cloud-runtime-smoke', options: `-c search_path=${schema},pg_catalog` });
  assert.equal((await pool.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
  for (let run = 0; run < 2; run++) for (const sql of statements) await pool.query(sql);
  check('isolated migration succeeds and is repeatable');

  const { createExportJobStore } = await import('../services/exportJobStore.mjs');
  const { PostgresSessionStore } = await import('../services/postgresSessionStore.mjs');
  const db = { query: (...args) => pool.query(...args), getClient: () => pool.connect() };
  let clock = Date.now();
  const now = () => clock;
  const logger = { error() {}, warn() {}, info() {} };
  const sessions = new PostgresSessionStore({ database: db, now, logger });
  const sessionCall = (method, ...args) => new Promise((resolve, reject) => sessions[method](...args, (error, result) => error ? reject(error) : resolve(result)));
  const sessionValue = { cookie: { expires: new Date(clock + 300_000).toISOString() }, state: 'synthetic-oauth-state' };
  step = 'oauth create and update';
  await sessionCall('set', 'synthetic-session', sessionValue);
  assert.deepEqual(await sessionCall('get', 'synthetic-session'), sessionValue);
  await sessionCall('set', 'synthetic-session', { ...sessionValue, state: 'updated-synthetic-state' });
  assert.equal((await sessionCall('get', 'synthetic-session')).state, 'updated-synthetic-state');
  await sessionCall('touch', 'synthetic-session', { cookie: { expires: new Date(clock + 3_600_000).toISOString() } });
  assert.equal((await pool.query('SELECT expires_at FROM oauth_sessions WHERE sid=$1', ['synthetic-session'])).rows[0].expires_at.getTime(), clock + 600_000);
  assert.equal(await sessions.healthy(), true);
  await sessionCall('destroy', 'synthetic-session');
  assert.equal(await sessionCall('get', 'synthetic-session'), null);
  check('PostgreSQL OAuth get/set/update/touch/destroy');
  step = 'oauth expiration';
  await sessionCall('set', 'expired-session', { cookie: { expires: new Date(clock + 1000).toISOString() }, state: 'synthetic' });
  clock += 1000;
  assert.equal(await sessionCall('get', 'expired-session'), null);
  await sessionCall('touch', 'expired-session', { cookie: { expires: new Date(clock + 60_000).toISOString() } });
  assert.equal(await sessionCall('get', 'expired-session'), null);
  clock += 60_000;
  await sessionCall('set', 'prune-trigger', { cookie: {}, state: 'synthetic' });
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM oauth_sessions WHERE expires_at <= $1', [new Date(clock)])).rows[0].count, 0);
  check('OAuth expiry cannot be revived; writes prune expired sessions');

  const store = createExportJobStore({ db, now });
  const reset = () => pool.query('TRUNCATE export_jobs');
  const create = (userId, requestKey, targetStore = store) => targetStore.create({ userId, requestKey, format: 'pdf' });
  const outcomes = results => ({ passed: results.filter(result => result.status === 'fulfilled'), failed: results.filter(result => result.status === 'rejected') });
  step = 'concurrent user quota';
  const perUser = outcomes(await Promise.allSettled(Array.from({ length: 8 }, (_, index) => create('quota-user', `quota-${index}`))));
  assert.equal(perUser.passed.length, 2); assert.equal(perUser.failed.length, 6);
  assert(perUser.failed.every(result => result.reason.code === 'EXPORT_BUSY'));
  check('concurrent admission enforces two pending jobs per user');
  await reset();
  step = 'concurrent global quota';
  const global = outcomes(await Promise.allSettled(Array.from({ length: 16 }, (_, index) => create(`global-user-${index}`, `global-${index}`))));
  assert.equal(global.passed.length, 8); assert.equal(global.failed.length, 8);
  assert(global.failed.every(result => result.reason.code === 'EXPORT_BUSY'));
  check('concurrent admission enforces eight pending jobs globally');
  await reset();
  step = 'concurrent idempotency';
  const replay = await Promise.all(Array.from({ length: 8 }, () => create('idempotent-user', 'same-request')));
  assert.equal(replay.filter(job => job.created).length, 1);
  assert.equal(new Set(replay.map(job => job.id)).size, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM export_jobs')).rows[0].count, 1);
  check('concurrent idempotency reserves exactly one job');
  await reset();
  step = 'daily quota';
  const limited = createExportJobStore({ db, now, maxPerDay: 3 });
  for (let index = 0; index < 3; index++) {
    const job = await create('daily-user', `daily-${index}`, limited);
    await limited.fail(job.id, { errorCode: 'SYNTHETIC_FAILURE' });
  }
  await assert.rejects(create('daily-user', 'daily-overflow', limited), { code: 'EXPORT_DAILY_LIMIT' });
  clock += 86_400_001;
  assert.equal((await create('daily-user', 'daily-next-day', limited)).created, true);
  check('rolling daily limit includes terminal jobs and resets after 24 hours');
  await reset();

  step = 'ownership and poll leases';
  const leaseJob = await create('lease-owner', 'lease-request');
  assert.equal(await store.getOwned(leaseJob.id, 'another-owner'), null);
  assert.equal((await store.getOwned(leaseJob.id, 'lease-owner')).id, leaseJob.id);
  assert.equal(await store.claimPoll(leaseJob.id), null);
  assert.equal((await store.setProvider(leaseJob.id, { containerId: 'cntr_synthetic' })).state, 'starting');
  await store.setProvider(leaseJob.id, { sourceFileId: 'cfile_synthetic' });
  assert.equal((await store.setProvider(leaseJob.id, { responseId: 'resp_synthetic' })).state, 'processing');
  const claims = (await Promise.all(Array.from({ length: 4 }, () => store.claimPoll(leaseJob.id)))).filter(Boolean);
  assert.equal(claims.length, 1);
  clock += 60_001;
  const replacement = await store.claimPoll(leaseJob.id);
  assert(replacement); assert.notEqual(replacement.pollToken, claims[0].pollToken);
  const fileName = `export-${clock}-0123456789abcdef.pdf`;
  const content = Buffer.from('%PDF-1.7\nSynthetic integration document');
  assert.equal(await store.complete(leaseJob.id, { fileName, content, pollToken: claims[0].pollToken }), null);
  assert.equal(await store.fail(leaseJob.id, { errorCode: 'STALE_POLLER', pollToken: claims[0].pollToken }), null);
  const completed = await store.complete(leaseJob.id, { fileName, content, pollToken: replacement.pollToken,
    containerId: 'cntr_synthetic', providerFileId: 'cfile_generated' });
  assert.equal(completed.state, 'completed');
  assert.equal(Object.hasOwn(await store.getOwned(leaseJob.id, 'lease-owner'), 'content'), false);
  assert.deepEqual((await store.findByFileName(fileName)).content, content);
  assert.equal(await store.findByFileName(`../${fileName}`), null);
  check('ownership and atomic poll leases prevent stale completion or failure');

  step = 'download and retention deadlines';
  const finishedAt = clock;
  assert.equal(Date.parse(completed.downloadExpiresAt), finishedAt + 900_000);
  assert.equal(Date.parse(completed.expiresAt), finishedAt + 3_600_000);
  clock = finishedAt + 900_000;
  assert.equal(await store.findByFileName(fileName), null);
  assert.equal((await pool.query('SELECT content IS NOT NULL AS retained FROM export_jobs WHERE id=$1', [leaseJob.id])).rows[0].retained, true);
  clock = finishedAt + 3_600_000;
  const cleanupFirst = await store.cleanup();
  assert(cleanupFirst.some(job => job.id === leaseJob.id && job.containerId === 'cntr_synthetic'));
  assert.equal((await store.getOwned(leaseJob.id, 'lease-owner')).state, 'expired');
  assert.equal((await pool.query('SELECT content IS NULL AS removed FROM export_jobs WHERE id=$1', [leaseJob.id])).rows[0].removed, true);
  assert((await store.cleanup()).some(job => job.id === leaseJob.id));
  await store.clearProvider(leaseJob.id);
  assert.equal((await store.cleanup()).length, 0);
  clock += 7 * 86_400_000 + 1;
  await store.cleanup();
  assert.equal(await store.getOwned(leaseJob.id, 'lease-owner'), null);
  check('fixed download/retention deadlines, cleanup retries, and metadata pruning');
  await reset();

  step = 'pending job timeout';
  const pending = await create('timeout-owner', 'timeout-request');
  await store.setProvider(pending.id, { containerId: 'cntr_timeout', responseId: 'resp_timeout' });
  clock += 600_000;
  assert.equal(await store.claimPoll(pending.id), null);
  assert((await store.cleanup()).some(job => job.id === pending.id));
  const expired = await store.getOwned(pending.id, 'timeout-owner');
  assert.equal(expired.state, 'expired'); assert.equal(expired.errorCode, 'EXPORT_TIMEOUT');
  check('ten-minute pending deadline expires orphaned jobs');
  await reset();

  step = 'binary storage quotas';
  const tiny = createExportJobStore({ db, now, maxFileBytes: 8, maxStoredBytes: 12 });
  const binaryJobs = await Promise.all([create('binary-a', 'binary-a', tiny), create('binary-b', 'binary-b', tiny)]);
  for (const job of binaryJobs) await tiny.setProvider(job.id, { responseId: `resp_${job.id}` });
  const binaryLeases = await Promise.all(binaryJobs.map(job => tiny.claimPoll(job.id)));
  await assert.rejects(tiny.complete(binaryJobs[0].id, { content: Buffer.alloc(9),
    fileName: `export-${clock}-0000000000000000.pdf`, pollToken: binaryLeases[0].pollToken }), { code: 'EXPORT_TOO_LARGE' });
  const binaryResults = outcomes(await Promise.allSettled(binaryJobs.map((job, index) => tiny.complete(job.id, {
    content: Buffer.alloc(8, index), fileName: `export-${clock}-${String(index).padStart(16, '0')}.pdf`, pollToken: binaryLeases[index].pollToken,
  }))));
  assert.equal(binaryResults.passed.length, 1); assert.equal(binaryResults.failed.length, 1);
  assert.equal(binaryResults.failed[0].reason.code, 'EXPORT_STORAGE_FULL');
  assert.equal(Number((await pool.query('SELECT COALESCE(sum(octet_length(content)),0) AS bytes FROM export_jobs')).rows[0].bytes), 8);
  check('per-file and concurrent global byte quotas are enforced atomically');
  report.passed = true;
} catch (error) {
  failure = error;
  report.passed = false;
  report.failure = { step, code: error.code || error.name || 'SMOKE_FAILED' };
} finally {
  await pool?.end().catch(() => { report.passed = false; });
  if (admin && schemaCreated) {
    try {
      assert(schemaValid(), 'Refusing to drop an unrecognized schema.');
      // The name is generated above, validated twice, and CREATE succeeded in
      // this process. No existing or public schema can reach this DROP.
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      report.schemaDropped = (await admin.query('SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].count === 0;
      if (!report.schemaDropped) report.passed = false;
    } catch (error) {
      report.passed = false;
      report.cleanupError = error.code || error.name || 'SCHEMA_CLEANUP_FAILED';
    }
  }
  if (admin && before) {
    try {
      const after = await fingerprints(admin);
      report.historicalRowsUnchanged = JSON.stringify(before) === JSON.stringify(after);
      report.finalCounts = Object.fromEntries(Object.entries(after).map(([table, value]) => [table, value.count]));
      report.databaseBytesAfter = Number((await admin.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes);
      if (!report.historicalRowsUnchanged) report.passed = false;
    } catch (error) {
      report.passed = false;
      report.historyCheckError = error.code || error.name || 'HISTORY_CHECK_FAILED';
    }
  }
  await admin?.end().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
console.log(JSON.stringify(report, null, 2));
if (failure || !report.passed || !report.schemaDropped || !report.historicalRowsUnchanged) process.exitCode = 1;
