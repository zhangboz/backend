// simple-test.mjs
import axios from 'axios';
import { GoogleAuth } from 'google-auth-library';

const API_VERSION = 'v1'; // Typically v1

// --- Helper function to get access token ---
async function getAccessToken(auth) {
    const client = await auth.getClient();
    const accessToken = (await client.getAccessToken()).token;
    return accessToken;
}

// --- 1. Create a new session ---
async function createAgentSession(auth, projectId, location, agentId, userId) {
    console.log(`Attempting to create session for user_id: ${userId}...`);
    const accessToken = await getAccessToken(auth);
    const url = `https://${location}-aiplatform.googleapis.com/${API_VERSION}/projects/${projectId}/locations/${location}/reasoningEngines/${agentId}:query`;

    const requestBody = {
        class_method: "create_session",
        input: {
            user_id: userId
        }
    };

    console.log(`Sending request to create session: ${url}`);
    console.log("Create session request body:", JSON.stringify(requestBody));

    try {
        const response = await axios.post(url, requestBody, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        console.log("Create session raw response data:", JSON.stringify(response.data, null, 2));

        // Extract session ID. Based on ADK structure, it's likely in response.data.output.id
        // or response.data.id if the "output" wrapper isn't used for this operation.
        let sessionId;
        if (response.data && response.data.output && typeof response.data.output === 'object' && response.data.output.id) {
            sessionId = response.data.output.id;
        } else if (response.data && response.data.id) { // Check if 'id' is at the root of response.data
            sessionId = response.data.id;
        } else {
            console.error("Full create_session response:", JSON.stringify(response.data, null, 2));
            throw new Error("Failed to extract session ID from create_session response. 'id' not found in expected locations (response.data.output.id or response.data.id).");
        }
        
        console.log(`Session created successfully. Session ID: ${sessionId}`);
        return sessionId;

    } catch (error) {
        console.error("Error creating agent session:");
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('Message:', error.message);
        }
        throw error;
    }
}

// --- 3. Stream the response with the test message ---
async function streamAgentQuery(auth, projectId, location, agentId, userId, sessionId, message) {
    console.log(`Attempting to stream query for session_id: ${sessionId}...`);
    const accessToken = await getAccessToken(auth);
    // Note: The alt=sse is important for streaming
    const url = `https://${location}-aiplatform.googleapis.com/${API_VERSION}/projects/${projectId}/locations/${location}/reasoningEngines/${agentId}:streamQuery?alt=sse`;

    const requestBody = {
        class_method: "stream_query", // Correctly adding class_method here
        input: {
            user_id: userId,
            session_id: sessionId,
            message: message
        }
    };

    console.log(`Sending request to stream query: ${url}`);
    console.log("Stream query request body:", JSON.stringify(requestBody));

    try {
        const response = await axios.post(url, requestBody, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            responseType: 'stream'
        });

        console.log('Stream query response (streaming started):');
        let fullResponseData = '';

        response.data.on('data', (chunk) => {
            const chunkString = chunk.toString();
            process.stdout.write(chunkString); // Print raw chunks as they arrive
            fullResponseData += chunkString;
        });

        return new Promise((resolve, reject) => {
            response.data.on('end', () => {
                console.log('\nStream ended.');
                resolve(fullResponseData);
            });
            response.data.on('error', (err) => {
                console.error('Stream error:', err);
                reject(err);
            });
        });
    } catch (error) {
        console.error("Error in streamAgentQuery function setup or initial request:");
        if (error.response) {
            console.error('Status:', error.response.status);
            // Error response for a stream might also be a stream
            if (error.response.data && typeof error.response.data.on === 'function') {
                let errorData = '';
                error.response.data.on('data', chunk => errorData += chunk.toString());
                error.response.data.on('end', () => console.error('Error Data Stream Content:', errorData));
            } else {
                console.error('Data:', JSON.stringify(error.response.data, null, 2));
            }
        } else {
            console.error('Message:', error.message);
        }
        throw error;
    }
}

// --- 4. Delete the session ---
async function deleteAgentSession(auth, projectId, location, agentId, userId, sessionId) {
    console.log(`Attempting to delete session_id: ${sessionId} for user_id: ${userId}...`);
    const accessToken = await getAccessToken(auth);
    const url = `https://${location}-aiplatform.googleapis.com/${API_VERSION}/projects/${projectId}/locations/${location}/reasoningEngines/${agentId}:query`;

    const requestBody = {
        class_method: "delete_session",
        input: {
            user_id: userId,
            session_id: sessionId
        }
    };

    console.log(`Sending request to delete session: ${url}`);
    console.log("Delete session request body:", JSON.stringify(requestBody));

    try {
        const response = await axios.post(url, requestBody, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        console.log("Delete session response data:", JSON.stringify(response.data, null, 2));
        // A successful delete might return an empty body or a simple success message.
        // Status code 200 is the main indicator.
        if (response.status === 200) {
            console.log(`Session ${sessionId} deleted successfully.`);
        } else {
            console.warn(`Session delete for ${sessionId} returned status ${response.status}.`);
        }
        return response.data;

    } catch (error) {
        console.error("Error deleting agent session:");
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('Message:', error.message);
        }
        throw error; // Re-throw to be caught by main
    }
}


// --- Main Execution Logic ---
async function main() {
    const PROJECT_ID = 'hwai-agent'; // Your Project ID
    const LOCATION = 'us-central1';   // Your Agent's Location
    const AGENT_ID = '1900985235680526336'; // Your Reasoning Engine ID (Resource_ID)
    const USER_ID_FOR_TEST = 'node_sdk_user_007'; // Example User ID
    const USER_MESSAGE = "This is a test message for the ADK agent using correct REST sequence.";

    const auth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    let sessionId = null; // To store the session ID

    try {
        console.log("Authenticating and initializing...");
        // Perform a quick auth check
        await getAccessToken(auth);
        console.log("Authentication successful.");

        // 1. Create a new session
        sessionId = await createAgentSession(auth, PROJECT_ID, LOCATION, AGENT_ID, USER_ID_FOR_TEST);

        if (sessionId) {
            // 2. (Session ID is already obtained from createAgentSession)
            console.log(`Proceeding with session ID: ${sessionId}`);

            // 3. Stream the response with the test message
            const streamedData = await streamAgentQuery(auth, PROJECT_ID, LOCATION, AGENT_ID, USER_ID_FOR_TEST, sessionId, USER_MESSAGE);
            
            console.log("\n--- Full raw response data collected from streamQuery ---");
            console.log(streamedData); // Log the full raw string

            // Attempt to parse the streamed data (assuming newline-delimited JSON objects)
            try {
                const jsonObjects = streamedData
                    .trim()
                    .split('\n') // Split by newline
                    .filter(line => line.trim() !== '') // Remove empty lines
                    .map(line => JSON.parse(line.replace(/^data: /, ''))); // Remove SSE "data: " prefix if present and parse

                if (jsonObjects.length > 0) {
                    console.log("\n--- Parsed individual JSON responses from streamQuery ---");
                    jsonObjects.forEach((res, i) => console.log(`Response ${i+1}:`, JSON.stringify(res, null, 2)));
                } else if (streamedData.trim() !== '') {
                    console.warn("Stream query returned data, but it couldn't be parsed into multiple JSON objects. Check raw output.");
                } else {
                    console.log("Stream query returned no data or only whitespace.");
                }
            } catch (e) {
                console.error("\nFailed to parse some/all parts of streamQuery response. Error:", e.message);
                console.error("This might happen if the stream doesn't contain valid newline-delimited JSON, or if SSE format is different.");
            }
        } else {
            console.error("Failed to obtain a session ID. Cannot proceed with stream query or delete.");
        }

    } catch (error) {
        console.error('\n--- An error occurred in the main execution flow ---');
        // Error message should have been logged by the function that threw it.
        // console.error("Error details:", error.message);
    } finally {
        // 4. Delete the session (if it was created)
        if (sessionId) {
            try {
                console.log(`\n--- Attempting to clean up by deleting session: ${sessionId} ---`);
                await deleteAgentSession(auth, PROJECT_ID, LOCATION, AGENT_ID, USER_ID_FOR_TEST, sessionId);
            } catch (deleteError) {
                console.error(`Failed to delete session ${sessionId} during cleanup:`, deleteError.message);
            }
        } else {
            console.log("\nNo session ID was obtained, skipping delete operation.");
        }
        console.log("\n--- Script finished ---");
    }
}

main();