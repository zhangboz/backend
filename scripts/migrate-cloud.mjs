import '../config.mjs';
import fs from 'node:fs/promises';
import db from '../db.mjs';

// Explicit allowlist: historical migrations include destructive snapshots.
// This migration adds runtime tables only and is safe to run again on startup.
const migration = new URL('../migrations/20261104_cloud_runtime.sql', import.meta.url);
let client;
try {
  client = await db.getClient();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(833311076)');
  await client.query(await fs.readFile(migration, 'utf8'));
  await client.query('COMMIT');
  console.log('Cloud runtime tables are ready (existing application data preserved).');
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => {});
  console.error('Cloud runtime migration failed:', error.code || 'MIGRATION_FAILED');
  process.exitCode = 1;
} finally {
  client?.release();
  await db.end();
}
