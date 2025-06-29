// ./AI_ChatBot/reasoningEngineClient.mjs
import axios from 'axios';
import { GoogleAuth } from 'google-auth-library';

const API_VERSION = 'v1';
const GOOGLE_AUTH_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

let authInstance;
let accessTokenCache = { token: null, expiry: 0 };

async function getAuthInstance() {
    if (!authInstance) {
        authInstance = new GoogleAuth({
            scopes: GOOGLE_AUTH_SCOPES
        });
    }
    return authInstance;
}

async function getAccessTokenInternal() {
    const now = Date.now();
    if (accessTokenCache.token && accessTokenCache.expiry > now + 60 * 1000) {
        return accessTokenCache.token;
    }

    const auth = await getAuthInstance();
    const client = await auth.getClient();
    if (!client) {
        console.error("REASONING_ENGINE_CLIENT_ERROR: Failed to get client from GoogleAuth object.");
        throw new Error("REASONING_ENGINE_CLIENT: Failed to get client from GoogleAuth object.");
    }
    const accessTokenResponse = await client.getAccessToken();
    if (!accessTokenResponse || !accessTokenResponse.token) {
        console.error("REASONING_ENGINE_CLIENT_ERROR: Failed to get access token from client.");
        throw new Error("REASONING_ENGINE_CLIENT: Failed to get access token from client.");
    }
    
    let expiresInSeconds = 3540; // Default
    if (accessTokenResponse.res && accessTokenResponse.res.data && typeof accessTokenResponse.res.data.expires_in === 'number') {
        expiresInSeconds = accessTokenResponse.res.data.expires_in;
    }
    
    accessTokenCache = {
        token: accessTokenResponse.token,
        expiry: now + expiresInSeconds * 1000
    };
    return accessTokenCache.token;
}

// Helper for detailed error logging
async function logDetailedError(context, error, additionalInfo = {}) {
    console.error(`\n--- REASONING_ENGINE_CLIENT_ERROR: CAUGHT ERROR in ${context} ---`);
    console.error(`Additional Info: ${JSON.stringify(additionalInfo)}`);
    console.error('Error Message:', error.message);
    console.error('Error Name:', error.name);
    // console.error('Error Stack:', error.stack); // Can be very verbose, uncomment if needed
    console.error('Full error object (stringified):', 
        JSON.stringify(error, Object.getOwnPropertyNames(error), 2));

    if (error.response) {
        console.error('error.response IS PRESENT.');
        console.error('Status:', error.response.status);
        if (error.response.data) {
            console.error('error.response.data IS PRESENT.');
            if (typeof error.response.data.on === 'function') { // Check if it's a stream
                let errorStreamData = '';
                console.error('error.response.data is a STREAM. Reading content:');
                try {
                    // Consuming a stream in Node.js:
                    const chunks = [];
                    for await (const chunk of error.response.data) {
                        chunks.push(Buffer.from(chunk));
                    }
                    errorStreamData = Buffer.concat(chunks).toString('utf-8');
                    console.error('Streamed error data content:', errorStreamData);
                } catch (streamReadError) {
                    console.error('Failed to read error data stream:', streamReadError.message);
                }
            } else {
                 console.error('Data (non-stream):', JSON.stringify(error.response.data, null, 2));
            }
        } else {
             console.error('error.response.data is NOT PRESENT (null, undefined, etc.).');
        }
    } else {
        console.error('error.response is NOT PRESENT (undefined). This is a likely source of "cannot read .data" if code assumes it exists.');
    }
    console.error(`--- END REASONING_ENGINE_CLIENT_ERROR for ${context} ---\n`);
}


// --- 1. Create a new session ---
export async function createAgentSession(projectId, location, agentId, userId) {
    const accessToken = await getAccessTokenInternal();
    const url = `https://${location}-aiplatform.googleapis.com/${API_VERSION}/projects/${projectId}/locations/${location}/reasoningEngines/${agentId}:query`;
    const requestBody = { class_method: "create_session", input: { user_id: userId } };

    try {
        const response = await axios.post(url, requestBody, {
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
        });
        let sessionId;
        if (response.data && response.data.output && typeof response.data.output === 'object' && response.data.output.id) {
            sessionId = response.data.output.id;
        } else if (response.data && response.data.id) {
            sessionId = response.data.id;
        } else {
            console.error(`REASONING_ENGINE_CLIENT_ERROR: Failed to extract session ID from create_session. Full response:`, JSON.stringify(response.data, null, 2));
            throw new Error("REASONING_ENGINE_CLIENT: Failed to extract session ID from create_session response.");
        }
        return sessionId;
    } catch (error) {
        await logDetailedError('createAgentSession', error, { projectId, location, agentId, userId });
        throw error;
    }
}

// --- 2. Stream the response with a message ---
export async function streamAgentQuery(projectId, location, agentId, userId, sessionId, message) {
    const accessToken = await getAccessTokenInternal();
    const url = `https://${location}-aiplatform.googleapis.com/${API_VERSION}/projects/${projectId}/locations/${location}/reasoningEngines/${agentId}:streamQuery?alt=sse`;
    const requestBody = { class_method: "stream_query", input: { user_id: userId, session_id: sessionId, message: message } };

    try {
        const response = await axios.post(url, requestBody, {
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            responseType: 'stream'
        });
        let fullResponseData = '';
        response.data.on('data', (chunk) => fullResponseData += chunk.toString());
        return new Promise((resolve, reject) => {
            response.data.on('end', () => {
                resolve(fullResponseData);
            });
            response.data.on('error', (streamError) => {
                logDetailedError('streamAgentQuery - stream.on(error)', streamError, { projectId, location, agentId, userId, sessionId })
                    .finally(() => reject(streamError)); // Ensure log completes before reject
            });
        });
    } catch (error) {
        await logDetailedError('streamAgentQuery - initial request', error, { projectId, location, agentId, userId, sessionId });
        throw error;
    }
}

// --- 3. Delete the session ---
export async function deleteAgentSession(projectId, location, agentId, userId, sessionId) {
    const accessToken = await getAccessTokenInternal();
    const url = `https://${location}-aiplatform.googleapis.com/${API_VERSION}/projects/${projectId}/locations/${location}/reasoningEngines/${agentId}:query`;
    const requestBody = { class_method: "delete_session", input: { user_id: userId, session_id: sessionId } };

    try {
        const response = await axios.post(url, requestBody, {
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
        });
        if (response.status === 200) {
        } else {
            console.warn(`REASONING_ENGINE_CLIENT_WARN: Session delete for ${sessionId} (user_id ${userId}) returned status ${response.status}. Data: ${JSON.stringify(response.data, null, 2)}`);
        }
        return response.data;
    } catch (error) {
        await logDetailedError('deleteAgentSession', error, { projectId, location, agentId, userId, sessionId });
        throw error;
    }
}