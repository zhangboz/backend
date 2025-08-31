import { Storage } from '@google-cloud/storage';
import { GoogleGenAI,
    createUserContent,
    createPartFromUri,
 } from '@google/genai';
import 'dotenv/config';

import path from 'path';
import fs from 'fs';
import mime from 'mime-types';
import { fileURLToPath } from 'url';
import db from '../db.mjs';
// Google GenAI Initialization
const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ 
    apiKey: apiKey
});

async function answerAgent(filePath) {
    const FAST_MODEL = "gemini-2.5-flash";
    const SMART_MODEL = "gemini-2.5-pro";
    const prompt1 = "Extract the text from the given file, if you encounter a image, just describe the image, do not try to anwer the question.";
    const promptFinal = `
You are an "Image to Answer" agent, your primary goal is to answer the questions from a student who uploads a picture/pdf and expecting a correct answer.
I engineered the user's prompt to help you with some relevant context from our database, labeled "supporting context 1:", "supporting context 2:", "supporting context 3:".
The context could come from the following sources: Textbook, Lecture notes, past exams, homework solutions, or other academic materials.
However, I can't guarantee the provided contexts are relevant, so please use your own judgement, but I do believe for hard questions, a relevant context could be helpful.
Otherwise if the question is simple, you can simply answer it without looking at the contexts.
Final reminder: Your job is to answer the question from the image as accurately as possible, the context is just there to help you to get the correct answer.
`;

    if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        throw new Error(`File not found: ${filePath}`);
    }
    console.log(`✅ File exists. Size: ${fs.statSync(filePath).size} bytes`);

    // Detect mimeType automatically
    const detectedMimeType = mime.lookup(filePath) || 'application/octet-stream';
    // End of mimeType detection
    console.log(`🔍 Detected MIME type: ${detectedMimeType}`);

    const timings = {};
    const overallStart = Date.now();

    try {
        console.log("📤 Uploading file to GenAI (requesting extraction)...");
        const uploadStart = Date.now();
        // Upload image for reuse
        const questionImage = await ai.files.upload({
            file: filePath,
            config: { mimeType: detectedMimeType }, 
        });
        timings.upload = Date.now() - uploadStart;
        // End of upload
        console.log("📥 Upload response received:");
        console.log(`   🔗 uri: ${questionImage.uri}`);
        console.log(`   🧾 mimeType: ${questionImage.mimeType}`);
        console.log(`   🆔 id/object: ${JSON.stringify(questionImage.id ?? questionImage)}`);

        console.log("🤖 Sending content generation request to Gemini (fast model)...");
        // Step 1. Text transcription
        const contentGenStart = Date.now();
        const response = await ai.models.generateContent({
            model: FAST_MODEL,
            contents: createUserContent([
                createPartFromUri(questionImage.uri, questionImage.mimeType),
                prompt1,
            ]),
        });
        timings.contentGeneration = Date.now() - contentGenStart;
        // End of text transcription
        console.log("📬 Response received from Gemini:");
        const duration = ((Date.now() - overallStart) / 1000).toFixed(2);
        console.log(`🕒 Completed in ${duration}s`);
        console.log("📝 Raw response object:");
        console.dir(response, { depth: 2 });
        console.log("🔎 Extracted text from Gemini (response.text):");
        console.log("📣 " + (response.text ?? "<no text returned>"));

        // Step 2. Generate text embedding
        console.log("🧮 Generating text embedding for semantic similarity search...");
        const embedStart = Date.now();
        const embeddingResponse = await ai.models.embedContent({
            model: "gemini-embedding-001",
            contents: response.text,
            // taskType: 'SEMANTIC_SIMILARITY',
            config: {
                outputDimensionality: 768
            }        
        });
        timings.embedding = Date.now() - embedStart;
        // End of embedding
        console.log("🧮 Embedding response (first 10 values):", embeddingResponse.embeddings[0].values.slice(0, 10));
        const actualDimensionality = embeddingResponse.embeddings[0].values.length;
        if (actualDimensionality !== 768) {
            console.error(`Embedding dimensionality mismatch: expected 768, got ${actualDimensionality}`);
            return response; 
        }
        console.log(`✅ Embedding dimensionality verified: ${actualDimensionality}`);

        // Step 3. PSQL similarity search (pgvector) - use COSINE similarity
        console.log("🔎 Running pgvector cosine similarity search (top 10) against chunks.embedding...");
        const dbQueryStart = Date.now();
        const vectorValues = embeddingResponse.embeddings?.[0]?.values;
        if (!Array.isArray(vectorValues) || vectorValues.length === 0) {
            throw new Error("No embedding vector returned from the model.");
        }
        const vectorLiteral = `[${vectorValues.join(',')}]`;
        const sql = `
            SELECT text,
                   1 - (embedding <#> $1::vector) AS similarity,
                   (embedding <#> $1::vector) AS cosine_distance
            FROM chunks
            ORDER BY similarity DESC
            LIMIT 10;
        `;
        let similarRows = [];
        try {
            const res = await db.query(sql, [vectorLiteral]);
            timings.dbQuery = Date.now() - dbQueryStart;
            similarRows = res.rows ?? [];
            console.log("Top 10 similar chunks (similarity = higher -> more similar):");
            similarRows.forEach((r, i) => {
                const sim = (typeof r.similarity === 'number') ? r.similarity.toFixed(4) : r.similarity;
                const preview = (r.text || "").replace(/\s+/g, ' ').trim().slice(0, 300);
                console.log(`#${i + 1} similarity=${sim} distance=${r.cosine_distance} text="${preview}${preview.length >= 300 ? '…' : ''}"`);
            });
        } catch (dbErr) {
            console.error("⚠️ Database similarity query failed:");
            console.error(dbErr);
            throw dbErr;
        }

        // Prepare top 3 supporting contexts
        const topContexts = (similarRows || []).slice(0, 3).map((r, idx) => {
            const text = (r && r.text) ? r.text.replace(/\s+/g, ' ').trim() : '';
            return `supporting context ${idx + 1}:\n${text}`;
        });

        // Step 4. Return the final response (include supporting contexts)
        console.log("📨 Sending final content generation request to Gemini (smart model)...");
        const answerResponseStart = Date.now();
        const contentsArray = [
            createPartFromUri(questionImage.uri, questionImage.mimeType),
            ...topContexts,
        ];
        const answerResponse = await ai.models.generateContent({
            model: FAST_MODEL,
            contents: createUserContent(contentsArray),
            config: {
                systemInstruction: promptFinal,
            }
        });
        timings.answerResponse = Date.now() - answerResponseStart;
        console.log("📪 Final answer response received from Gemini:");
        console.log("📣 " + (answerResponse.text ?? "<no text returned>"));

        timings.total = Date.now() - overallStart;
        console.log("⏱️ Timer summary (in milliseconds):", timings);
        return answerResponse.text;
    } catch (err) {
        console.error("⚠️ Error during processing:");
        console.error(err);
        throw err;
    }
};

// Resolve local path for Midterm2_blank.pdf in the same folder as this script
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const localFile = path.join(__dirname, 'quiz4_upload.pdf');

console.log("🧪 Running local test with quiz4_upload.pdf");
answerAgent(localFile)
    .then(() => console.log("✅ answerAgent finished successfully"))
    .catch(err => {
        console.error("❌ answerAgent failed:");
        console.error(err);
        process.exit(1);
    });