import { randomUUID } from 'node:crypto';
import database from '../db.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const QUOTA_LOCK = 833311075;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const FILE_NAME = /^export-\d{13}-[a-f0-9]{16}\.(pdf|docx)$/;
const JOB_COLUMNS = `id, user_id, format, state, response_id, source_file_id, container_id,
  provider_file_id, filename, error_code, request_key, created_at, updated_at,
  completed_at, expires_at, download_expires_at, poll_after, poll_token`;

export class ExportStoreError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'ExportStoreError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
  }
}

const iso = value => value == null ? null : new Date(value).toISOString();
function asJob(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, format: row.format, state: row.state,
    responseId: row.response_id, sourceFileId: row.source_file_id,
    containerId: row.container_id, providerFileId: row.provider_file_id,
    fileName: row.filename, errorCode: row.error_code, requestKey: row.request_key,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    completedAt: iso(row.completed_at), expiresAt: iso(row.expires_at),
    downloadExpiresAt: iso(row.download_expires_at), pollAfter: iso(row.poll_after),
    pollToken: row.poll_token,
    ...(Object.hasOwn(row, 'content') ? { content: row.content } : {}),
  };
}

function validateId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw new ExportStoreError('Invalid export job ID.', 400, 'INVALID_EXPORT_JOB');
  }
}
function requirePollToken(pollToken) {
  if (typeof pollToken !== 'string' || !UUID.test(pollToken)) {
    throw new ExportStoreError('The export poll lease is missing.', 409, 'EXPORT_LEASE_REQUIRED');
  }
}
function safeError(error) {
  if (error instanceof ExportStoreError) return error;
  // Database diagnostics may contain connection details or parameter values.
  return new ExportStoreError('The export service is temporarily unavailable. Please try again.', 503, 'EXPORT_STORE_UNAVAILABLE');
}

/**
 * PostgreSQL-backed state survives Render restarts. No timer or continuous DB
 * polling is started here, allowing Neon to scale to zero when the app is idle.
 * Binary cleanup happens on startup/user activity via cleanup(), and before
 * quota-changing writes. Access expires immediately even before physical cleanup.
 */
export function createExportJobStore({
  db = database, now = Date.now,
  maxPendingPerUser = 2, maxPendingGlobal = 8, maxPerDay = 30,
  maxFileBytes = 8 * 1024 * 1024, maxStoredBytes = 64 * 1024 * 1024,
  pendingTtlMs = 10 * MINUTE, fileRetentionMs = HOUR, downloadTtlMs = 15 * MINUTE,
  leaseMs = MINUTE, metadataRetentionMs = 7 * DAY,
} = {}) {
  async function transact(work) {
    let client;
    try {
      client = await db.getClient();
      await client.query('BEGIN');
      // A transaction-scoped lock makes both admission and storage limits atomic
      // across concurrent HTTP requests and multiple API processes.
      await client.query('SELECT pg_advisory_xact_lock($1)', [QUOTA_LOCK]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw safeError(error);
    } finally {
      client?.release();
    }
  }
  async function query(sql, values) {
    try { return await db.query(sql, values); }
    catch (error) { throw safeError(error); }
  }
  async function expire(client, timestamp) {
    await client.query(`UPDATE export_jobs SET state = 'expired', content = NULL,
      error_code = CASE WHEN state IN ('starting', 'processing') THEN 'EXPORT_TIMEOUT' ELSE error_code END,
      updated_at = $1, poll_after = NULL, poll_token = NULL
      WHERE state IN ('starting', 'processing', 'completed') AND expires_at <= $1`, [timestamp]);
  }

  return {
    async create({ id = randomUUID(), userId, format, requestKey = null }) {
      validateId(id);
      if (!['pdf', 'docx'].includes(format) || userId == null || !String(userId).length || String(userId).length > 200 ||
          (requestKey !== null && (typeof requestKey !== 'string' || !requestKey.length || requestKey.length > 200))) {
        throw new ExportStoreError('Invalid export request.', 400, 'INVALID_EXPORT_REQUEST');
      }
      const timestamp = new Date(now());
      return transact(async client => {
        await expire(client, timestamp);
        if (requestKey !== null) {
          const existing = (await client.query(`SELECT ${JOB_COLUMNS} FROM export_jobs
            WHERE user_id = $1 AND request_key = $2`, [String(userId), requestKey])).rows[0];
          if (existing) {
            if (existing.format !== format) throw new ExportStoreError('This export request key was already used for another format.', 409, 'EXPORT_REQUEST_CONFLICT');
            return { ...asJob(existing), created: false };
          }
        }
        const counts = (await client.query(`SELECT
          COUNT(*) FILTER (WHERE state IN ('starting', 'processing')) AS global_pending,
          COUNT(*) FILTER (WHERE state IN ('starting', 'processing') AND user_id = $1) AS user_pending,
          COUNT(*) FILTER (WHERE user_id = $1 AND created_at >= $2) AS user_daily
          FROM export_jobs`, [String(userId), new Date(timestamp.getTime() - DAY)])).rows[0];
        if (Number(counts.global_pending) >= maxPendingGlobal || Number(counts.user_pending) >= maxPendingPerUser) {
          throw new ExportStoreError('Document exports are busy. Please wait for an existing export to finish.', 429, 'EXPORT_BUSY');
        }
        if (Number(counts.user_daily) >= maxPerDay) {
          throw new ExportStoreError('The daily document export limit has been reached. Please try again later.', 429, 'EXPORT_DAILY_LIMIT');
        }
        const row = (await client.query(`INSERT INTO export_jobs
          (id, user_id, format, state, request_key, created_at, updated_at, expires_at)
          VALUES ($1, $2, $3, 'starting', $4, $5, $5, $6) RETURNING ${JOB_COLUMNS}`,
        [id, String(userId), format, requestKey, timestamp, new Date(timestamp.getTime() + pendingTtlMs)])).rows[0];
        return { ...asJob(row), created: true };
      });
    },

    async setProvider(id, { responseId = null, sourceFileId = null, containerId = null } = {}) {
      validateId(id);
      const timestamp = new Date(now());
      const result = await query(`UPDATE export_jobs SET
        response_id = COALESCE($2, response_id), source_file_id = COALESCE($3, source_file_id),
        container_id = COALESCE($4, container_id),
        state = CASE WHEN COALESCE($2, response_id) IS NULL THEN 'starting' ELSE 'processing' END,
        updated_at = $5
        WHERE id = $1 AND state IN ('starting', 'processing') AND expires_at > $5
          AND ($2::text IS NULL OR response_id IS NULL OR response_id = $2)
        RETURNING ${JOB_COLUMNS}`, [id, responseId, sourceFileId, containerId, timestamp]);
      return asJob(result.rows[0]);
    },

    async getOwned(id, userId) {
      if (typeof id !== 'string' || !UUID.test(id) || userId == null) return null;
      const result = await query(`SELECT ${JOB_COLUMNS} FROM export_jobs WHERE id = $1 AND user_id = $2`, [id, String(userId)]);
      return asJob(result.rows[0]);
    },

    async claimPoll(id, options = {}) {
      validateId(id);
      const timestamp = new Date(now());
      const duration = options.leaseMs ?? leaseMs;
      if (!Number.isSafeInteger(duration) || duration < 1000 || duration > 5 * MINUTE) {
        throw new ExportStoreError('Invalid export poll lease.', 400, 'INVALID_EXPORT_LEASE');
      }
      const result = await query(`UPDATE export_jobs SET poll_token = $2, poll_after = $3, updated_at = $4
        WHERE id = $1 AND state = 'processing' AND response_id IS NOT NULL AND expires_at > $4
          AND (poll_after IS NULL OR poll_after <= $4)
        RETURNING ${JOB_COLUMNS}`, [id, randomUUID(), new Date(timestamp.getTime() + duration), timestamp]);
      return asJob(result.rows[0]);
    },

    async updateProcessing(id, { pollToken, delayMs = 2000 } = {}) {
      validateId(id);
      requirePollToken(pollToken);
      if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MINUTE) {
        throw new ExportStoreError('Invalid export poll delay.', 400, 'INVALID_EXPORT_LEASE');
      }
      const timestamp = new Date(now());
      const result = await query(`UPDATE export_jobs SET poll_after = $3, poll_token = NULL, updated_at = $4
        WHERE id = $1 AND poll_token = $2 AND state = 'processing' AND expires_at > $4
        RETURNING ${JOB_COLUMNS}`, [id, pollToken, new Date(timestamp.getTime() + delayMs), timestamp]);
      return asJob(result.rows[0]);
    },

    async complete(id, { content, fileName, providerFileId = null, containerId = null, pollToken } = {}) {
      validateId(id);
      requirePollToken(pollToken);
      if (!(content instanceof Uint8Array) || content.byteLength === 0) {
        throw new ExportStoreError('The AI service did not produce a document.', 502, 'EXPORT_EMPTY_FILE');
      }
      if (content.byteLength > maxFileBytes) {
        throw new ExportStoreError('The generated document is too large. Please export a shorter document.', 413, 'EXPORT_TOO_LARGE');
      }
      if (typeof fileName !== 'string' || !FILE_NAME.test(fileName)) {
        throw new ExportStoreError('Invalid export file name.', 400, 'INVALID_EXPORT_FILENAME');
      }
      const timestamp = new Date(now());
      return transact(async client => {
        await expire(client, timestamp);
        const current = (await client.query(`SELECT ${JOB_COLUMNS} FROM export_jobs
          WHERE id = $1 AND state = 'processing' AND poll_token = $2 AND expires_at > $3 FOR UPDATE`,
        [id, pollToken, timestamp])).rows[0];
        if (!current) return null; // A newer poll lease or expiry won the race.
        if (!fileName.endsWith(`.${current.format}`)) {
          throw new ExportStoreError('The generated document has the wrong format.', 502, 'EXPORT_FORMAT_MISMATCH');
        }
        const total = Number((await client.query('SELECT COALESCE(SUM(octet_length(content)), 0) AS stored_bytes FROM export_jobs')).rows[0].stored_bytes);
        if (total + content.byteLength > maxStoredBytes) {
          throw new ExportStoreError('Temporary document storage is full. Please try again later.', 503, 'EXPORT_STORAGE_FULL');
        }
        const result = await client.query(`UPDATE export_jobs SET state = 'completed', content = $2, filename = $3,
          provider_file_id = COALESCE($4, provider_file_id), container_id = COALESCE($5, container_id),
          completed_at = $6, updated_at = $6, expires_at = $7, download_expires_at = $8,
          poll_after = NULL, poll_token = NULL, error_code = NULL
          WHERE id = $1 AND poll_token = $9 AND state = 'processing' RETURNING ${JOB_COLUMNS}`,
        [id, Buffer.isBuffer(content) ? content : Buffer.from(content), fileName, providerFileId, containerId,
          timestamp, new Date(timestamp.getTime() + fileRetentionMs), new Date(timestamp.getTime() + downloadTtlMs), pollToken]);
        return asJob(result.rows[0]);
      });
    },

    async fail(id, { errorCode = 'EXPORT_FAILED', pollToken = null } = {}) {
      validateId(id);
      if (pollToken !== null) requirePollToken(pollToken);
      if (typeof errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)) errorCode = 'EXPORT_FAILED';
      const timestamp = new Date(now());
      const result = await query(`UPDATE export_jobs SET state = 'failed', error_code = $2,
        content = NULL, updated_at = $3, poll_after = NULL, poll_token = NULL
        WHERE id = $1 AND state IN ('starting', 'processing')
          AND (($4::uuid IS NULL AND poll_token IS NULL) OR poll_token = $4)
        RETURNING ${JOB_COLUMNS}`, [id, errorCode, timestamp, pollToken]);
      return asJob(result.rows[0]);
    },

    async findByFileName(fileName) {
      if (typeof fileName !== 'string' || !FILE_NAME.test(fileName)) return null;
      const result = await query(`SELECT ${JOB_COLUMNS}, content FROM export_jobs
        WHERE filename = $1 AND state = 'completed' AND download_expires_at > $2
          AND expires_at > $2 AND content IS NOT NULL`, [fileName, new Date(now())]);
      return asJob(result.rows[0]);
    },

    async cleanup() {
      const timestamp = new Date(now());
      return transact(async client => {
        await expire(client, timestamp);
        await client.query(`DELETE FROM export_jobs WHERE state IN ('completed', 'failed', 'expired')
          AND updated_at < $1 AND content IS NULL AND response_id IS NULL AND source_file_id IS NULL
          AND container_id IS NULL AND provider_file_id IS NULL`, [new Date(timestamp.getTime() - metadataRetentionMs)]);
        const result = await client.query(`SELECT ${JOB_COLUMNS} FROM export_jobs
          WHERE state IN ('completed', 'failed', 'expired') AND
            (response_id IS NOT NULL OR source_file_id IS NOT NULL OR container_id IS NOT NULL OR provider_file_id IS NOT NULL)
          ORDER BY updated_at ASC LIMIT 32`);
        return result.rows.map(asJob);
      });
    },

    async clearProvider(id) {
      validateId(id);
      const result = await query(`UPDATE export_jobs SET response_id = NULL, source_file_id = NULL,
        container_id = NULL, provider_file_id = NULL
        WHERE id = $1 AND state IN ('completed', 'failed', 'expired') RETURNING ${JOB_COLUMNS}`, [id]);
      return asJob(result.rows[0]);
    },
  };
}
