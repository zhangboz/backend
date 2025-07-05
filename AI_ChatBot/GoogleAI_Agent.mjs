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
// MODIFICATION: Define agent IDs for different languages and features
const AGENT_ID_ENGLISH = '4439889525610643456';
const AGENT_ID_CHINESE = '2598550596713709568';
const AGENT_ID_HANDWRITTEN = '1457503817686843392'; // <-- NEW AGENT ID

// MODIFICATION: Function now accepts a language parameter
async function imageUnderstand(filePath, mimeType, userId, language = 'en') {
    let sessionId = null;
    let imageBase64 = '';

    if (!userId) {
        throw new Error("imageUnderstand was called without a userId. This is a protected resource.");
    }

    // MODIFICATION: Select the agent ID based on the language parameter
    const AGENT_IDS = {
        'en': AGENT_ID_ENGLISH,
        'zh': AGENT_ID_CHINESE,
    };
    const agentId = AGENT_IDS[language] || AGENT_IDS['en']; // Default to English if language is invalid

    try {
        const imageBuffer = await fs.readFile(filePath);
        imageBase64 = imageBuffer.toString('base64');

        sessionId = await createAgentSession(
            PROJECT_ID,
            LOCATION,
            agentId, // Use the selected agentId
            userId
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

        console.log(`Request for user_id: ${userId} to agent_id: ${agentId} (session: ${sessionId}) using language: ${language} being sent with image.`);

        const streamedData = await streamAgentQuery(
            PROJECT_ID,
            LOCATION,
            agentId, // Use the selected agentId
            userId,
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
                    console.warn(`Agent response for user_id: ${userId}, session: ${sessionId} - first agent's response object did not have the expected text structure.`);
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
                        console.warn(`Agent response for user_id: ${userId}, session: ${sessionId} - second agent's response object did not have the expected text structure (or was missing).`);
                    }
                } else {
                     console.log(`Agent response for user_id: ${userId}, session: ${sessionId} - only one agent response object received.`);
                }
                
                console.log(`Agent responses successfully processed for user_id: ${userId}, session: ${sessionId}.`);
                return { text1: text1, text2: text2 }; // Return an object

            } else if (streamedData.trim() !== '') {
                console.warn(`Agent for user_id: ${userId}, session: ${sessionId} returned data, but it couldn't be parsed into JSON objects.`);
                return { text1: streamedData, text2: "" }; // Return raw as text1 if parsing fails
            } else {
                console.log(`Agent for user_id: ${userId}, session: ${sessionId} returned no data or only whitespace.`);
                return { text1: "", text2: "" };
            }
        } catch (e) {
            console.error(`\nFailed to process/parse agent stream response for user_id: ${userId}, session: ${sessionId}. Error:`, e.message);
            return { text1: "", text2: "" }; // Return empty on parsing error
        }

    } catch (error) {
        console.error(`\n--- Error in imageUnderstand for user_id: ${userId}, file: ${filePath} ---`);
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
                    agentId, // Use the selected agentId
                    userId,
                    sessionId
                );
            } catch (deleteError) {
                console.error(`Failed to delete image agent session ${sessionId} for user_id ${userId}:`, deleteError.message);
            }
        }
    }
}

// --- NEW FUNCTION for Handwritten Notes ---
async function handWrittenToMarkdown(filePath, mimeType, userId) {
    let sessionId = null;
    let imageBase64 = '';
    const agentId = AGENT_ID_HANDWRITTEN; // Use the new agent ID

    if (!userId) {
        throw new Error("handWrittenToMarkdown was called without a userId. This is a protected resource.");
    }

    try {
        const imageBuffer = await fs.readFile(filePath);
        imageBase64 = imageBuffer.toString('base64');

        sessionId = await createAgentSession(
            PROJECT_ID,
            LOCATION,
            agentId,
            userId
        );

        const messageContentObject = {
            role: "user",
            parts: [
                { text: "image" },
                { inline_data: { mime_type: mimeType, data: imageBase64 } }
            ]
        };

        console.log(`Request for user_id: ${userId} to agent_id: ${agentId} (session: ${sessionId}) for handwriting transcription being sent with image.`);

        const streamedData = await streamAgentQuery(
            PROJECT_ID,
            LOCATION,
            agentId,
            userId,
            sessionId,
            messageContentObject
        );

        // This new agent only returns one text output.
        try {
            const jsonStrings = streamedData.trim().split('\n').filter(line => line.trim() !== '');
            const jsonObjects = [];
            jsonStrings.forEach(jsonString => {
                try {
                    jsonObjects.push(JSON.parse(jsonString));
                } catch (parseError) {
                    console.warn("Minor: Failed to parse a JSON string from the stream:", parseError.message, "String:", jsonString);
                }
            });

            let text1 = "";

            if (jsonObjects.length > 0) {
                const agentResponse = jsonObjects[0];
                if (agentResponse?.content?.parts?.[0]?.text) {
                    text1 = agentResponse.content.parts[0].text;
                } else {
                    console.warn(`Agent response for user_id: ${userId}, session: ${sessionId} - response object did not have the expected text structure.`);
                }
                console.log(`Agent response successfully processed for user_id: ${userId}, session: ${sessionId}.`);
                return { text1: text1 }; // Return an object with only text1
            } else if (streamedData.trim() !== '') {
                console.warn(`Agent for user_id: ${userId}, session: ${sessionId} returned data, but it couldn't be parsed into JSON objects.`);
                return { text1: streamedData }; // Return raw as text1 if parsing fails
            } else {
                console.log(`Agent for user_id: ${userId}, session: ${sessionId} returned no data or only whitespace.`);
                return { text1: "" };
            }
        } catch (e) {
            console.error(`\nFailed to process/parse agent stream response for user_id: ${userId}, session: ${sessionId}. Error:`, e.message);
            return { text1: "" }; // Return empty on parsing error
        }

    } catch (error) {
        console.error(`\n--- Error in handWrittenToMarkdown for user_id: ${userId}, file: ${filePath} ---`);
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
                    agentId,
                    userId,
                    sessionId
                );
            } catch (deleteError) {
                console.error(`Failed to delete handwriting agent session ${sessionId} for user_id ${userId}:`, deleteError.message);
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
        // NOTE: This main test function will now fail without a valid userId.
        // You would need to simulate one for local testing, e.g., 'test_user_123'
        console.log("NOTE: The local `main` test function requires a hardcoded user ID to run standalone.");
        // const agentResponses = await imageUnderstand(imageFilePath, imageMimeType, 'manual_test_user_id');

        // if (agentResponses) {
        //     console.log("\n--- Texts returned by imageUnderstand() [Main Execution] ---");
        // } else {
        //     console.log("imageUnderstand() did not return expected response object. Check logs.");
        // }
    } catch (error) {
        console.error("Main execution caught an error from imageUnderstand(). See previous logs for details.");
    }
}

// Run the main test function if this script is executed directly
// main(); // Comment out if you only want to import it

// Export the functions for use in other modules
export { imageUnderstand, handWrittenToMarkdown };