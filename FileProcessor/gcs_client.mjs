// backend/FileProcessor/gcs-client.mjs (FINAL VERSION)
import { Storage } from '@google-cloud/storage';

let storage;
const bucketName = process.env.GCS_BUCKET_NAME;

// 1. Check for Render's Secret File path (The best way for production)
if (process.env.GCS_KEYFILE_PATH) {
    console.log(`[GCS Client] Authenticating using Secret File at: ${process.env.GCS_KEYFILE_PATH}`);
    storage = new Storage({
        keyFilename: process.env.GCS_KEYFILE_PATH,
    });
}
// 2. Check for the Base64 variable (Fallback for production)
else if (process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64) {
    console.log('[GCS Client] Authenticating using Base64 credentials.');
    try {
        const decodedKey = Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64, 'base64').toString('utf-8');
        const credentials = JSON.parse(decodedKey);
        storage = new Storage({
            projectId: credentials.project_id,
            credentials,
        });
    } catch (error) {
        console.error('[GCS Client] FATAL: Failed to parse Base64 credentials.', error);
    }
}
// 3. If neither is present, assume local development (or any environment with Application Default Credentials)
else {
    console.log('[GCS Client] No explicit credentials found. Attempting to use Application Default Credentials (for local dev).');
    storage = new Storage();
}

if (!bucketName) {
    console.warn('[GCS Client] GCS_BUCKET_NAME is not set.');
}

// Export the bucket object, making sure it's not null if setup failed.
export const bucket = storage && bucketName ? storage.bucket(bucketName) : null;

if (!bucket) {
    console.error('[GCS Client] FATAL: GCS Bucket could not be initialized. Check configuration and credentials.');
}