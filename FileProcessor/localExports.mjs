import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fileNamePattern = /^export-\d{13}-[a-f0-9]{16}\.(pdf|docx)$/;
export const DOWNLOAD_TTL_MS = 15 * 60 * 1000;
export const FILE_RETENTION_MS = 60 * 60 * 1000;

export function getExportDir() {
  return path.resolve(backendDir, process.env.EXPORT_DIR || 'temp_exports');
}

export function getSigningSecret() {
  const secret = process.env.EXPORT_SIGNING_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('Export signing secret is not configured.');
  return secret;
}

export function isExportFileName(fileName) {
  return typeof fileName === 'string' && fileNamePattern.test(fileName);
}

export function completedExport(filePath, now = Date.now()) {
  const fileName = path.basename(filePath);
  if (!isExportFileName(fileName)) throw new Error('Invalid export file name.');
  return { fileName, completedAt: now, expiresAt: new Date(now + DOWNLOAD_TTL_MS).toISOString() };
}

function signatureFor(fileName, expires, secret) {
  return createHmac('sha256', secret).update('local-export-v1\n' + fileName + '\n' + expires).digest('hex');
}

export function signedDownloadUrl(result, options = {}) {
  if (!isExportFileName(result?.fileName)) throw new Error('Invalid export result.');
  const expires = Date.parse(result.expiresAt);
  if (!Number.isSafeInteger(expires)) throw new Error('Invalid export expiration.');
  const baseUrl = options.backendUrl || process.env.BACKEND_URL || 'http://localhost:5000';
  const url = new URL('/api/export/download/' + encodeURIComponent(result.fileName), baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid BACKEND_URL.');
  url.searchParams.set('expires', String(expires));
  url.searchParams.set('signature', signatureFor(result.fileName, expires, options.secret || getSigningSecret()));
  return url.toString();
}

export function verifyDownload(fileName, expiresValue, signature, options = {}) {
  if (!isExportFileName(fileName) || typeof expiresValue !== 'string' || !/^\d{13}$/.test(expiresValue) ||
      typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expires = Number(expiresValue);
  if (expires <= (options.now ?? Date.now())) return false;
  const expected = signatureFor(fileName, expires, options.secret || getSigningSecret());
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

export async function existingExportPath(fileName, exportDir = getExportDir()) {
  if (!isExportFileName(fileName)) return null;
  const directory = path.resolve(exportDir);
  const filePath = path.resolve(directory, fileName);
  if (path.dirname(filePath) !== directory) return null;
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink() ? filePath : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function cleanupExpiredExports(options = {}) {
  const directory = options.exportDir || getExportDir();
  const now = options.now ?? Date.now();
  await fs.mkdir(directory, { recursive: true });
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !isExportFileName(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isFile() && now - stat.mtimeMs >= FILE_RETENTION_MS) {
        await fs.unlink(filePath);
        removed++;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

export function startExportCleanup(options = {}) {
  const cleanup = () => cleanupExpiredExports(options).catch((error) => {
    console.error('[Exports] Cleanup failed:', error.code || error.name);
  });
  void cleanup();
  const interval = setInterval(cleanup, 10 * 60 * 1000);
  interval.unref();
  return () => clearInterval(interval);
}
