// GoogleAI_Agent.mjs
import 'dotenv/config';
import fs from 'fs/promises';
// import path from 'path'; // No longer strictly needed
import {
    createAgentSession,
    streamAgentQuery,
    deleteAgentSession
} from './reasoningEngineClient.mjs';
import { text } from 'stream/consumers';

// --- Configuration for the Agent ---
const PROJECT_ID = 'hwai-agent';
const LOCATION = 'us-central1';
const AGENT_ID_IMAGE = '4439889525610643456';
const USER_ID_FOR_IMAGE_TEST = 'node_sdk_image_user_006'; // Increment

async function imageUnderstand(filePath, mimeType) {
    let sessionId = null;
    let imageBase64 = '';

    try {
        const imageBuffer = await fs.readFile(filePath);
        imageBase64 = imageBuffer.toString('base64');

        sessionId = await createAgentSession(
            PROJECT_ID,
            LOCATION,
            AGENT_ID_IMAGE,
            USER_ID_FOR_IMAGE_TEST
        );

        const messageContentObject = {
            role: "user",
            parts: [
                {
                    text: "image"
                },
                {
                    inline_data: {
                        mime_type: mimeType,
                        data: imageBase64
                    }
                }
            ]
        };

        console.log(`Request for user_id: ${USER_ID_FOR_IMAGE_TEST} to agent_id: ${AGENT_ID_IMAGE} (session: ${sessionId}) being sent with image.`);

        const streamedData = await streamAgentQuery(
            PROJECT_ID,
            LOCATION,
            AGENT_ID_IMAGE,
            USER_ID_FOR_IMAGE_TEST,
            sessionId,
            messageContentObject
        );

        try {
            const jsonStrings = streamedData
                .trim()
                .split('\n')
                .filter(line => line.trim() !== '');

            const jsonObjects = [];
            jsonStrings.forEach(jsonString => {
                try {
                    jsonObjects.push(JSON.parse(jsonString));
                } catch (parseError) {
                    console.warn("Minor: Failed to parse a JSON string from the stream:", parseError.message, "String:", jsonString);
                }
            });

            let text1 = "";
            let text2 = "";

            if (jsonObjects.length > 0) {
                // Extract text from the first agent's response
                const firstAgentResponse = jsonObjects[0];
                if (firstAgentResponse &&
                    firstAgentResponse.content &&
                    firstAgentResponse.content.parts &&
                    Array.isArray(firstAgentResponse.content.parts) &&
                    firstAgentResponse.content.parts.length > 0 &&
                    typeof firstAgentResponse.content.parts[0].text === 'string') {
                    text1 = firstAgentResponse.content.parts[0].text;
                } else {
                    console.warn(`Agent response for user_id: ${USER_ID_FOR_IMAGE_TEST}, session: ${sessionId} - first agent's response object did not have the expected text structure.`);
                }

                // Extract text from the second agent's response (if it exists)
                if (jsonObjects.length > 1) {
                    const secondAgentResponse = jsonObjects[1];
                    if (secondAgentResponse &&
                        secondAgentResponse.content &&
                        secondAgentResponse.content.parts &&
                        Array.isArray(secondAgentResponse.content.parts) &&
                        secondAgentResponse.content.parts.length > 0 &&
                        typeof secondAgentResponse.content.parts[0].text === 'string') {
                        text2 = secondAgentResponse.content.parts[0].text;
                    } else {
                        console.warn(`Agent response for user_id: ${USER_ID_FOR_IMAGE_TEST}, session: ${sessionId} - second agent's response object did not have the expected text structure (or was missing).`);
                    }
                } else {
                     console.log(`Agent response for user_id: ${USER_ID_FOR_IMAGE_TEST}, session: ${sessionId} - only one agent response object received.`);
                }
                
                console.log(`Agent responses successfully processed for user_id: ${USER_ID_FOR_IMAGE_TEST}, session: ${sessionId}.`);
                return { text1: text1, text2: text2 }; // Return an object

            } else if (streamedData.trim() !== '') {
                console.warn(`Agent for user_id: ${USER_ID_FOR_IMAGE_TEST}, session: ${sessionId} returned data, but it couldn't be parsed into JSON objects.`);
                return { text1: streamedData, text2: "" }; // Return raw as text1 if parsing fails
            } else {
                console.log(`Agent for user_id: ${USER_ID_FOR_IMAGE_TEST}, session: ${sessionId} returned no data or only whitespace.`);
                return { text1: "", text2: "" };
            }
        } catch (e) {
            console.error(`\nFailed to process/parse agent stream response for user_id: ${USER_ID_FOR_IMAGE_TEST}, session: ${sessionId}. Error:`, e.message);
            return { text1: "", text2: "" }; // Return empty on parsing error
        }

    } catch (error) {
        console.error(`\n--- Error in imageUnderstand for user_id: ${USER_ID_FOR_IMAGE_TEST}, file: ${filePath} ---`);
        if (error.response && error.response.data) {
            if (typeof error.response.data.on === 'function') {
                let errorData = '';
                console.error('Streaming error response content:');
                error.response.data.on('data', chunk => errorData += chunk.toString());
                await new Promise(resolve => error.response.data.on('end', () => {
                    console.error(errorData);
                    resolve();
                }));
            } else {
                console.error('Error Data from Axios:', JSON.stringify(error.response.data, null, 2));
            }
        } else if (error.message) {
            console.error('Error Message:', error.message);
        } else {
            console.error('Unknown error:', error);
        }
        throw error;
    } finally {
        if (sessionId) {
            try {
                await deleteAgentSession(
                    PROJECT_ID,
                    LOCATION,
                    AGENT_ID_IMAGE,
                    USER_ID_FOR_IMAGE_TEST,
                    sessionId
                );
            } catch (deleteError) {
                console.error(`Failed to delete image agent session ${sessionId} for user_id ${USER_ID_FOR_IMAGE_TEST}:`, deleteError.message);
            }
        }
    }
}

// --- Main Execution to Test (Example Usage) ---
async function main() {
    const imageFilePath = './math151_simple_derivative.png'; // Ensure this file exists
    const imageMimeType = 'image/png';

    try {
        await fs.access(imageFilePath);
    } catch (e) {
        console.error(`Critical Error: Test image file not found at '${imageFilePath}'. Please ensure it exists.`);
        return;
    }

    try {
        const agentResponses = await imageUnderstand(imageFilePath, imageMimeType);

        if (agentResponses) {
            console.log("\n--- Texts returned by imageUnderstand() [Main Execution] ---");
        } else {
            console.log("imageUnderstand() did not return expected response object. Check logs.");
        }
    } catch (error) {
        console.error("Main execution caught an error from imageUnderstand(). See previous logs for details.");
    }
}

// Run the main test function if this script is executed directly
// main(); // Comment out if you only want to import it

// Export the function for use in other modules
export { imageUnderstand };