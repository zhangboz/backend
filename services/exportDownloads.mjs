import { createHmac, timingSafeEqual } from 'node:crypto';

const fileNamePattern = /^export-\d{13}-[a-f0-9]{16}\.(pdf|docx)$/;
export const DOWNLOAD_TTL_MS = 15 * 60 * 1000;
export const FILE_RETENTION_MS = 60 * 60 * 1000;
export const isExportFileName = name => typeof name === 'string' && fileNamePattern.test(name);
function getSigningSecret() {
  const secret = process.env.EXPORT_SIGNING_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('Export signing secret is not configured.');
  return secret;
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
