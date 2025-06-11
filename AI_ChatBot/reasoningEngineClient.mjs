// reasoningEngineClient.mjs
import axios from 'axios';
import { GoogleAuth } from 'google-auth-library';

const API_VERSION = 'v1';
const GOOGLE_AUTH_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

let authInstance;
let accessTokenCache = { token: null, expiry: 0 };

async function getAuthInstance() {
    if (!authInstance) {
        // Keep this log as it's a one-time initialization message.
        console.log("REASONING_ENGINE_CLIENT: Initializing GoogleAuth instance...");
        authInstance = new GoogleAuth({
            scopes: GOOGLE_AUTH_SCOPES
        });
    }
    return authInstance;
}

async function getAccessTokenInternal() {
    const now = Date.now();
    if (accessTokenCache.token && accessTokenCache.expiry > now + 60 * 1000) {
        // console.log("REASONING_ENGINE_CLIENT: Using cached access token."); // Cleaned
        return accessTokenCache.token;
    }

    // console.log("REASONING_ENGINE_CLIENT: Fetching new access token..."); // Cleaned
    const auth = await getAuthInstance();
    const client = await auth.getClient();
    if (!client) {
        // Errors are critical, keep them.
        console.error("REASONING_ENGINE_CLIENT_ERROR: Failed to get client from GoogleAuth object.");
        throw new Error("REASONING_ENGINE_CLIENT: Failed to get client from GoogleAuth object.");
    }
    const accessTokenResponse = await client.getAccessToken();
    if (!accessTokenResponse || !accessTokenResponse.token) {
        console.error("REASONING_ENGINE_CLIENT_ERROR: Failed to get access token from client.");
        throw new Error("REASONING_ENGINE_CLIENT: Failed to get access token from client.");
    }
    
    accessTokenCache = {
        token: accessTokenResponse.token,
        expiry: now + (accessTokenResponse.res.data.expires_in || 3540) * 1000
    };
    // console.log("REASONING_ENGINE_CLIENT: New access token fetched and cached."); // Cleaned
    return accessTokenCache.token;
}

// --- 1. Create a new session ---
export async function createAgentSession(projectId, location, agentId, userId) {
    // console.log(`REASONING_ENGINE_CLIENT: Attempting to create session for user_id: ${userId}, agent_id: ${agentId}...`); // Cleaned
    const accessToken = await getAccessTokenInternal();
    const url = `https://${location}-aiplatform.googleapis.com/${API_VERSION}/projects/${projectId}/locations/${location}/reasoningEngines/${agentId}:query`;

    const requestBody = {
        class_method: "create_session",
        input: {
            user_id: userId
        }
    };

    // console.log(`REASONING_ENGINE_CLIENT: Sending request to create session: ${url}`); // Cleaned
    // console.log("REASONING_ENGINE_CLIENT: Create session request body:", JSON.stringify(requestBody)); // Cleaned for production

    try {
        const response = await axios.post(url, requestBody, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        // console.log("REASONING_ENGINE_CLIENT: Create session raw response data:", JSON.stringify(response.data, null, 2)); // Cleaned for production

        let sessionId;
        if (response.data && response.data.output && typeof response.data.output === 'object' && response.data.output.id) {
            sessionId = response.data.output.id;
        } else if (response.data && response.data.id) {
            sessionId = response.data.id;
        } else {
            console.error(`REASONING_ENGINE_CLIENT_ERROR: Failed to extract session ID from create_session response for user_id: ${userId}, agent_id: ${agentId}.`);
            console.error("REASONING_ENGINE_CLIENT_ERROR: Full create_session response:", JSON.stringify(response.data, null, 2)); // Keep for error diagnosis
            throw new Error("REASONING_ENGINE_CLIENT: Failed to extract session ID from create_session response.");
        }
        
        // console.log(`REASONING_ENGINE_CLIENT: Session created successfully. Session ID: ${sessionId} for user_id: ${userId}`); // Cleaned
        return sessionId;

    } catch (error) {
        console.error(`REASONING_ENGINE_CLIENT_ERROR: Error creating agent session for user_id: ${userId}, agent_id: ${agentId}:`);
        if (error.response) {
            console.error('REASONING_ENGINE_CLIENT_ERROR: Status:', error.response.status);
            console.error('REASONING_ENGINE_CLIENT_ERROR: Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('REASONING_ENGINE_CLIENT_ERROR: Message:', error.message);
        }
        throw error; // Re-throw for the calling function to handle
    }
}

// --- 2. Stream the response with a message ---
export async function streamAgentQuery(projectId, location, agentId, userId, sessionId, message) {
    // console.log(`REASONING_ENGINE_CLIENT: Attempting to stream query for session_id: ${sessionId}, user_id: ${userId}...`); // Cleaned
    const accessToken = await getAccessTokenInternal();
    const url = `https://${location}-aiplatform.googleapis.com/${API_VERSION}/projects/${projectId}/locations/${location}/reasoningEngines/${agentId}:streamQuery?alt=sse`;

    const requestBody = {
        class_method: "stream_query",
        input: {
            user_id: userId,
            session_id: sessionId,
            message: message
        }
    };

    // console.log(`REASONING_ENGINE_CLIENT: Sending request to stream query: ${url}`); // Cleaned
    // console.log("REASONING_ENGINE_CLIENT: Stream query request body:", JSON.stringify(requestBody)); // Cleaned for production (can be very large with images)

    try {
        const response = await axios.post(url, requestBody, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            responseType: 'stream'
        });

        // console.log('REASONING_ENGINE_CLIENT: Stream query response (streaming started)...'); // Cleaned
        let fullResponseData = '';

        response.data.on('data', (chunk) => {
            const chunkString = chunk.toString();
            // process.stdout.write(chunkString); // Removed: Calling script (GoogleAI_Agent.mjs) will handle final output display
            fullResponseData += chunkString;
        });

        return new Promise((resolve, reject) => {
            response.data.on('end', () => {
                // console.log('\nREASONING_ENGINE_CLIENT: Stream ended.'); // Cleaned
                resolve(fullResponseData);
            });
            response.data.on('error', (streamError) => { // Renamed 'err' to 'streamError' for clarity
                console.error(`REASONING_ENGINE_CLIENT_ERROR: Stream error during query for session_id: ${sessionId}, user_id: ${userId}:`, streamError.message);
                reject(streamError);
            });
        });
    } catch (error) {
        console.error(`REASONING_ENGINE_CLIENT_ERROR: Error in streamAgentQuery setup or initial request for session_id: ${sessionId}, user_id: ${userId}:`);
        if (error.response) {
            console.error('REASONING_ENGINE_CLIENT_ERROR: Status:', error.response.status);
            // Error response for a stream might also be a stream or JSON
            if (error.response.data && typeof error.response.data.on === 'function') {
                let errorData = '';
                console.error('REASONING_ENGINE_CLIENT_ERROR: Streaming error response content:');
                error.response.data.on('data', chunk => errorData += chunk.toString());
                // Use await here to ensure the full error data is logged before the function potentially exits
                await new Promise(resolveErrorStream => {
                    error.response.data.on('end', () => {
                        console.error(errorData);
                        resolveErrorStream();
                    });
                    error.response.data.on('error', (errStreamErr) => { // Handle errors on the error stream itself
                        console.error('REASONING_ENGINE_CLIENT_ERROR: Error reading error data stream:', errStreamErr.message);
                        resolveErrorStream(); // Resolve anyway to not hang
                    });
                });
            } else if (error.response.data) {
                console.error('REASONING_ENGINE_CLIENT_ERROR: Data:', JSON.stringify(error.response.data, null, 2));
            } else {
                console.error('REASONING_ENGINE_CLIENT_ERROR: No response data from server on error.');
            }
        } else {
            console.error('REASONING_ENGINE_CLIENT_ERROR: Message:', error.message);
        }
        throw error;
    }
}

// --- 3. Delete the session ---
export async function deleteAgentSession(projectId, location, agentId, userId, sessionId) {
    // console.log(`REASONING_ENGINE_CLIENT: Attempting to delete session_id: ${sessionId} for user_id: ${userId}...`); // Cleaned
    const accessToken = await getAccessTokenInternal();
    const url = `https://${location}-aiplatform.googleapis.com/${API_VERSION}/projects/${projectId}/locations/${location}/reasoningEngines/${agentId}:query`;

    const requestBody = {
        class_method: "delete_session",
        input: {
            user_id: userId,
            session_id: sessionId
        }
    };

    // console.log(`REASONING_ENGINE_CLIENT: Sending request to delete session: ${url}`); // Cleaned
    // console.log("REASONING_ENGINE_CLIENT: Delete session request body:", JSON.stringify(requestBody)); // Cleaned

    try {
        const response = await axios.post(url, requestBody, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        // console.log("REASONING_ENGINE_CLIENT: Delete session response data:", JSON.stringify(response.data, null, 2)); // Cleaned
        if (response.status === 200) {
            // console.log(`REASONING_ENGINE_CLIENT: Session ${sessionId} for user_id ${userId} deleted successfully.`); // Cleaned
        } else {
            // Log warnings for unexpected non-200 success statuses
            console.warn(`REASONING_ENGINE_CLIENT_WARN: Session delete for ${sessionId} (user_id ${userId}) returned status ${response.status}. Data: ${JSON.stringify(response.data, null, 2)}`);
        }
        return response.data;

    } catch (error) {
        console.error(`REASONING_ENGINE_CLIENT_ERROR: Error deleting agent session ${sessionId} for user_id ${userId}:`);
        if (error.response) {
            console.error('REASONING_ENGINE_CLIENT_ERROR: Status:', error.response.status);
            console.error('REASONING_ENGINE_CLIENT_ERROR: Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('REASONING_ENGINE_CLIENT_ERROR: Message:', error.message);
        }
        throw error;
    }
}