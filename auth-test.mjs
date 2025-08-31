// backend/auth-final-test.mjs
import { Storage } from '@google-cloud/storage';
import { GoogleGenAI } from '@google/genai';

// THE FIX FOR TEST 3:
// When importing a CommonJS module in an ES Module file,
// you sometimes need to access the `.v1` or similar client version directly.
// We also need to get the PredictionServiceClient for this library.
async function runAuthFinalTest() {
  console.log("🚀 Starting Final Google Cloud Authentication Test 🚀");
  console.log("Compares authentication methods for different Google SDKs.\n");

  // --- 🧪 TEST 1: @google-cloud/storage (Unchanged) ---
  console.log("--- 🧪 TEST 1: @google-cloud/storage ---");
  try {
    const storage = new Storage();
    const [buckets] = await storage.getBuckets();
    console.log("✅ SUCCESS: @google-cloud/storage correctly used the Service Account via ADC.");
    console.log(`Successfully fetched ${buckets.length} buckets.`);
  } catch (error) {
    console.error("❌ FAIL: @google-cloud/storage was unable to authenticate.", error.message);
  }

  // --- 🧪 TEST 2: @google/genai (With Correct Response Parsing) ---
  console.log("\n\n--- 🧪 TEST 2: @google/genai (Google AI SDK with API Key) ---");
  if (!process.env.GEMINI_API_KEY) {
    console.warn("⚠️ SKIPPED: GEMINI_API_KEY environment variable not set.");
  } else {
    try {
      const ai = new GoogleGenAI( {apiKey: process.env.GEMINI_API_KEY});
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [{ role: "user", parts: [{ text: "Confirm you are working." }] }],
      });

      // --- THE FIX FOR TEST 2 ---
      // The response object has a `response` property, and we call `text()` on that.
      const text = response.text;
      // --- END FIX ---

      console.log("✅ SUCCESS: @google/genai correctly authenticated using the provided API Key.");
      console.log("🤖 Gemini Response:", text.trim());
    } catch (error) {
      console.error("❌ FAIL: @google/genai SDK failed.", error.message);
    }
  }

  // --- 🧪 TEST 3: @google-cloud/vertex-ai (With Correct Constructor) ---
  console.log("\n\n--- 🧪 TEST 3: @google-cloud/vertex-ai (The 'Correct' way for Servers) ---");

    try {
      const ai = new GoogleGenAI({
        vertexai: true,
        project: 'hwai-agent',
        location: 'us-central1'
      });
      const req = {
        model: "gemini-2.5-flash",
        contents: [
          { role: 'user',
            parts: [{ 
              text: `Hello, briefly introduce yourself.`
            }]
          }
        ],
      };
      const response = await ai.models.generateContent(req);
      const text = response.text;
      console.log("✅ SUCCESS: @google-cloud/vertex-ai correctly authenticated using the provided Service Account.");
      console.log("🤖 Vertex AI Response:", text.trim());
    } catch (error) {
      console.error("❌ FAIL: @google-cloud/vertex-ai SDK failed.", error.message);
    }
  }
runAuthFinalTest();