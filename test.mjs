// ./test.mjs
import fs from 'fs/promises';
import path from 'path'; // For robust path joining
import {
    createAgentSession,
    streamAgentQuery,
    deleteAgentSession
} from './AI_ChatBot/reasoningEngineClient.mjs'; // Adjusted path

// --- Configuration ---
// These should ideally come from environment variables in a real app,
// but for a test script, hardcoding is okay if they are stable.
const PROJECT_ID = process.env.TEST_PROJECT_ID || 'hwai-agent';
const LOCATION = process.env.TEST_LOCATION || 'us-central1';
const AGENT_ID_IMAGE = process.env.TEST_AGENT_ID_IMAGE || '4439889525610643456'; // Your image agent ID
const USER_ID_PREFIX = 'test_mjs_user_'; // To create unique user IDs for testing

// Image details
const IMAGE_FILE_NAME = 'math151_simple_derivative.png';
const IMAGE_MIME_TYPE = 'image/png'; // Assuming PNG

async function runTest() {
    console.log("--- Starting reasoningEngineClient.mjs Test ---");
    const imageFilePath = path.resolve(IMAGE_FILE_NAME); // Use absolute path

    // 0. Check if GOOGLE_APPLICATION_CREDENTIALS is set (important for Render)
    console.log("Checking GOOGLE_APPLICATION_CREDENTIALS env var...");
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        console.log(`GOOGLE_APPLICATION_CREDENTIALS is set to: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
        try {
            await fs.access(process.env.GOOGLE_APPLICATION_CREDENTIALS);
            console.log("GOOGLE_APPLICATION_CREDENTIALS file is ACCESSIBLE.");
        } catch (err) {
            console.error("ERROR: GOOGLE_APPLICATION_CREDENTIALS file is NOT ACCESSIBLE or does not exist:", err.message);
            console.error("Please ensure the path is correct and the file exists in your Render environment.");
            // return; // Optionally exit if critical, or let it try and fail in GoogleAuth
        }
    } else {
        console.warn("WARNING: GOOGLE_APPLICATION_CREDENTIALS environment variable is NOT SET.");
        console.warn("The google-auth-library might try to find default credentials, but setting this explicitly is recommended for Render.");
    }


    // 1. Check if image file exists
    console.log(`\nStep 1: Checking for image file at ${imageFilePath}...`);
    let imageBase64;
    try {
        const imageBuffer = await fs.readFile(imageFilePath);
        imageBase64 = imageBuffer.toString('base64');
        console.log("Image file read successfully and encoded to base64.");
    } catch (err) {
        console.error(`ERROR: Could not read image file '${imageFilePath}'. Make sure it's in the root directory.`, err.message);
        return; // Stop the test if image is missing
    }

    const testUserId = USER_ID_PREFIX + Date.now(); // Create a unique user ID for this test run
    let sessionId = null;

    try {
        // 2. Test createAgentSession
        console.log(`\nStep 2: Testing createAgentSession with user_id: ${testUserId}...`);
        sessionId = await createAgentSession(PROJECT_ID, LOCATION, AGENT_ID_IMAGE, testUserId);
        if (sessionId) {
            console.log(`SUCCESS: createAgentSession returned session ID: ${sessionId}`);
        } else {
            console.error("FAILURE: createAgentSession did not return a session ID or returned falsy.");
            // No need to proceed if session creation failed
            return;
        }

        // 3. Test streamAgentQuery
        console.log(`\nStep 3: Testing streamAgentQuery with session_id: ${sessionId}...`);
        const messageContentObject = {
            role: "user",
            parts: [
                { text: "Describe this image." }, // Example prompt
                {
                    inline_data: {
                        mime_type: IMAGE_MIME_TYPE,
                        data: imageBase64
                    }
                }
            ]
        };

        const streamedData = await streamAgentQuery(
            PROJECT_ID,
            LOCATION,
            AGENT_ID_IMAGE,
            testUserId,
            sessionId,
            messageContentObject
        );

        if (streamedData && typeof streamedData === 'string') {
            console.log("SUCCESS: streamAgentQuery returned data.");
            console.log("Streamed Data (first 500 chars):", streamedData.substring(0, 500) + (streamedData.length > 500 ? "..." : ""));
            // Try to parse it (similar to GoogleAI_Agent.mjs)
            try {
                const jsonStrings = streamedData.trim().split('\n').filter(line => line.trim() !== '');
                const jsonObjects = jsonStrings.map(s => JSON.parse(s));
                console.log("Parsed JSON objects from stream:", JSON.stringify(jsonObjects, null, 2));
            } catch (parseError) {
                console.warn("Warning: Could not parse all streamed data into JSON objects.", parseError.message);
            }
        } else {
            console.error("FAILURE: streamAgentQuery did not return string data or returned falsy.");
        }

    } catch (error) {
        console.error("\n--- TEST SCRIPT CAUGHT AN ERROR ---");
        // The detailed error should have already been logged by reasoningEngineClient.mjs
        // console.error("Error message in test.mjs:", error.message); // Redundant if detailed logging works
    } finally {
        // 4. Test deleteAgentSession (if sessionId was created)
        if (sessionId) {
            console.log(`\nStep 4: Testing deleteAgentSession for session_id: ${sessionId}...`);
            try {
                await deleteAgentSession(PROJECT_ID, LOCATION, AGENT_ID_IMAGE, testUserId, sessionId);
                console.log(`SUCCESS: deleteAgentSession call completed for session ID: ${sessionId}. Check logs for server confirmation.`);
            } catch (deleteError) {
                console.error(`FAILURE: deleteAgentSession call failed for session ID: ${sessionId}.`);
                // Detailed error already logged by reasoningEngineClient.mjs
            }
        } else {
            console.log("\nStep 4: Skipping deleteAgentSession because session ID was not obtained.");
        }
    }

    console.log("\n--- Test Finished ---");
}

runTest();