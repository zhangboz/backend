// backend/FileProcessor/gcs_client.mjs

import { Storage } from '@google-cloud/storage';

let storage;
const bucketName = process.env.GCS_BUCKET_NAME;
const rawBucketName = process.env.GCS_RAW_BUCKET_NAME; // <-- Get the new bucket name

// ... (existing authentication logic remains the same)
// 1. Check for Render's Secret File path
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log(`[GCS Client] Authenticating using Secret File at: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
    storage = new Storage({
        keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    });
}
// 2. Check for the Base64 variable
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
// 3. If neither is present, assume local development
else {
    console.log('[GCS Client] No explicit credentials found. Attempting to use Application Default Credentials (for local dev).');
    storage = new Storage();
}

if (!bucketName) {
    console.warn('[GCS Client] GCS_BUCKET_NAME is not set.');
}
if (!rawBucketName) { // <-- Add a check for the new bucket
    console.warn('[GCS Client] GCS_RAW_BUCKET_NAME is not set.');
}


// Export the bucket objects, making sure they're not null if setup failed.
export const bucket = storage && bucketName ? storage.bucket(bucketName) : null;
export const rawBucket = storage && rawBucketName ? storage.bucket(rawBucketName) : null; // <-- EXPORT THE NEW BUCKET

if (!bucket) {
    console.error('[GCS Client] FATAL: Main GCS Bucket could not be initialized. Check configuration and credentials.');
}
if (!rawBucket) { // <-- Add a check for the new bucket
    console.error('[GCS Client] FATAL: Raw GCS Bucket could not be initialized. Check configuration and credentials.');
}