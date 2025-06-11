import { GoogleGenAI } from '@google/genai';
import wav from 'wav';
import 'dotenv/config';
import http from 'http';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks'; // For timing
import { createHash } from 'node:crypto'; // For ETag

if (!process.env.GEMINI_API_KEY) {
    console.error("FATAL ERROR: GEMINI_API_KEY environment variable is not set.");
    process.exit(1);
}

// Corrected: Added 'req' as a parameter
async function generateAndStreamAudio(req, res, textToSpeak, voiceName = 'Kore') {
    const mainStartTime = performance.now();
    let geminiApiCallStartTime, geminiApiCallEndTime, pcmDecodeTime, wavEncodingStartTime;

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    console.log(`[Server] Request for: "${textToSpeak}"`);

    try {
        geminiApiCallStartTime = performance.now();
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-preview-tts",
            contents: [{ parts: [{ text: textToSpeak }] }],
            config: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName },
                    },
                },
            },
        });
        geminiApiCallEndTime = performance.now();
        console.log(`[Server] Gemini API call duration: ${(geminiApiCallEndTime - geminiApiCallStartTime).toFixed(2)} ms`);

        const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!data) {
            throw new Error('No audio data received from API');
        }

        const pcmDecodeStartTime = performance.now();
        const pcmData = Buffer.from(data, 'base64');
        const pcmDecodeEndTime = performance.now();
        console.log(`[Server] Base64 to PCM Buffer decoding: ${(pcmDecodeEndTime - pcmDecodeStartTime).toFixed(2)} ms`);

        const channels = 1;
        const sampleRate = 24000;
        const bitDepth = 16;

        const etag = `W/"${createHash('md5').update(textToSpeak).digest('hex')}"`;
        
        // Corrected: Using 'req.headers' which is now available
        if (req.headers['if-none-match'] === etag) {
            console.log('[Server] ETag match. Sending 304 Not Modified.');
            res.setHeader('ETag', etag); // Still good to send ETag with 304
            res.writeHead(304);
            res.end();
            const fullEndTime = performance.now();
            console.log(`[Server] Total 304 response time: ${(fullEndTime - mainStartTime).toFixed(2)} ms`);
            return;
        }

        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.writeHead(200);

        const wavWriter = new wav.Writer({
            channels: channels,
            sampleRate: sampleRate,
            bitDepth: bitDepth,
        });

        wavEncodingStartTime = performance.now();
        wavWriter.pipe(res);
        wavWriter.write(pcmData);
        wavWriter.end(() => {
            const wavEncodingEndTime = performance.now();
            console.log(`[Server] WAV encoding and streaming completion: ${(wavEncodingEndTime - wavEncodingStartTime).toFixed(2)} ms`);
            const fullEndTime = performance.now();
            console.log(`[Server] Total audio generation and streaming time: ${(fullEndTime - mainStartTime).toFixed(2)} ms`);
            console.log(`[Server] PCM data size: ${pcmData.length} bytes`);
        });

        wavWriter.on('error', (err) => {
            console.error('[Server] Error during WAV writing/streaming:', err);
            if (!res.headersSent) { // Check if headers are sent before trying to write error header
                try {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'WAV streaming error' }));
                } catch (e) {
                    console.error("[Server] Error sending error response:", e);
                }
            } else if (!res.writableEnded) {
                res.end(); // Try to end the response if possible
            }
        });

    } catch (error) {
        console.error('[Server] Error generating audio stream:', error);
        if (!res.headersSent) {
            try {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to generate audio', details: error.message }));
            } catch (e) {
                console.error("[Server] Error sending error response:", e);
            }
        } else if (!res.writableEnded) {
            res.end();
        }
        const fullEndTime = performance.now();
        console.log(`[Server] Total error processing time: ${(fullEndTime - mainStartTime).toFixed(2)} ms`);
    }
}

const server = http.createServer(async (req, res) => {
    // Moved URL parsing and text extraction here to be available for generateAndStreamAudio
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const textToSpeak = requestUrl.searchParams.get('text');

    if (requestUrl.pathname === '/speech' && req.method === 'GET') {
        if (!textToSpeak) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing text parameter' }));
            return;
        }
        // Corrected: Passing 'req', 'res', and 'textToSpeak'
        await generateAndStreamAudio(req, res, textToSpeak);
    } else if (requestUrl.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(clientHtml);
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}.`);
    console.log(`Access client at http://localhost:${PORT}/`);
    console.log(`Example TTS endpoint: http://localhost:${PORT}/speech?text=hello`);
});

// For simplicity, HTML is embedded. In a real app, serve it from a file.
const clientHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TTS Streaming Test</title>
    <style>
        body { font-family: system-ui, sans-serif; margin: 20px; background-color: #f4f4f4; color: #333; }
        .container { max-width: 700px; margin: auto; background-color: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1, h2 { color: #333; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input[type="text"] { width: calc(100% - 22px); padding: 10px; margin-bottom: 15px; border: 1px solid #ccc; border-radius: 4px; }
        button { padding: 10px 15px; margin-right: 10px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; }
        button:hover { background-color: #0056b3; }
        button:disabled { background-color: #ccc; cursor: not-allowed; }
        audio { width: 100%; margin-top: 20px; }
        pre { background-color: #eee; padding: 10px; border-radius: 4px; white-space: pre-wrap; word-wrap: break-word; font-size: 0.9em; max-height: 200px; overflow-y: auto;}
        .timing-info { margin-top: 15px; font-size: 0.9em; color: #555; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Text-to-Speech Streaming</h1>
        <label for="textInput">Enter text:</label>
        <input type="text" id="textInput" value="Hello, this is a test of fast streaming audio with client-side caching for better subsequent playback.">
        <button id="playButton">Play Audio</button>
        <button id="clearCacheButton">Clear Client Cache</button>

        <h2>Audio Player</h2>
        <audio id="audioPlayer" controls></audio>
        
        <h2>Status & Timings</h2>
        <pre id="statusLog">Enter text and click play.</pre>
        <div class="timing-info" id="clientTimingInfo"></div>
    </div>

    <script>
        const textInput = document.getElementById('textInput');
        const playButton = document.getElementById('playButton');
        const clearCacheButton = document.getElementById('clearCacheButton');
        const audioPlayer = document.getElementById('audioPlayer');
        const statusLog = document.getElementById('statusLog');
        const clientTimingInfo = document.getElementById('clientTimingInfo');

        const audioCache = new Map(); 

        function logStatus(message) {
            console.log(message);
            const now = new Date();
            const timeString = now.toLocaleTimeString();
            statusLog.textContent = \`[\${timeString}] \${message}\\n\` + statusLog.textContent.substring(0, 2000);
        }

        clearCacheButton.addEventListener('click', () => {
            const keys = Array.from(audioCache.keys());
            audioCache.forEach((value, key) => {
                if (value.blobUrl) {
                    URL.revokeObjectURL(value.blobUrl);
                }
            });
            audioCache.clear();
            logStatus(\`Client cache cleared. Found and revoked \${keys.length} items.\`);
        });

        playButton.addEventListener('click', async () => {
            const text = textInput.value.trim();
            if (!text) {
                logStatus("Please enter some text.");
                return;
            }

            playButton.disabled = true;
            logStatus(\`Requesting audio for: "\${text}"\`);
            clientTimingInfo.innerHTML = ''; 

            const audioUrl = \`/speech?text=\${encodeURIComponent(text)}\`;

            if (audioCache.has(text) && audioCache.get(text).blobUrl) {
                const cachedData = audioCache.get(text);
                logStatus("Playing from client Blob cache...");
                audioPlayer.src = cachedData.blobUrl;
                audioPlayer.play().catch(e => logStatus(\`Playback error (cache): \${e.message}\`));
                clientTimingInfo.innerHTML = \`Played from client cache. Original download: \${cachedData.downloadDurationMs.toFixed(2)} ms.\`;
                playButton.disabled = false;
                return;
            }

            logStatus("Streaming audio from server (for fast start)...");
            audioPlayer.src = audioUrl; 
            audioPlayer.play().catch(e => {
                logStatus(\`Initial playback error (stream): \${e.message}\`);
                // If initial play fails, we might not want to proceed with blob fetching,
                // or handle it differently. For now, we continue.
            });

            let fetchStartTime, fetchEndTime;
            try {
                logStatus("Simultaneously fetching full audio to cache as Blob...");
                fetchStartTime = performance.now();
                
                // Fetch with cache-busting for the Blob if desired, or rely on server ETag for 304
                // For this example, we'll let the browser and server ETags handle caching for the second fetch.
                const response = await fetch(audioUrl); 
                
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(\`HTTP error fetching for blob! Status: \${response.status} \${response.statusText}. Body: \${errorText}\`);
                }
                
                // Check if response was from cache (e.g. 304 scenario handled by browser)
                if (response.status === 304) { // This won't happen directly in fetch like this, browser handles 304 transparently
                    logStatus("Blob fetch: Server indicated Not Modified (304), browser should use its cache.");
                }


                const blob = await response.blob();
                fetchEndTime = performance.now();
                const downloadDurationMs = fetchEndTime - fetchStartTime;

                logStatus(\`Full audio (\${(blob.size / 1024).toFixed(2)} KB) downloaded for Blob caching in \${downloadDurationMs.toFixed(2)} ms.\`);
                
                if (audioCache.has(text) && audioCache.get(text).blobUrl) {
                    URL.revokeObjectURL(audioCache.get(text).blobUrl);
                }

                const blobUrl = URL.createObjectURL(blob);
                audioCache.set(text, { blobUrl: blobUrl, blob: blob, downloadDurationMs: downloadDurationMs });
                logStatus("Audio cached as Blob. Next play for this text will use cache.");
                clientTimingInfo.innerHTML += \`<br>Blob download: \${downloadDurationMs.toFixed(2)} ms. Size: \${(blob.size / 1024).toFixed(2)} KB\`;


            } catch (error) {
                logStatus(\`Error fetching audio for Blob cache: \${error.message}\`);
                console.error("Fetch for Blob cache error:", error);
            } finally {
                playButton.disabled = false;
            }
        });

        audioPlayer.addEventListener('loadedmetadata', () => {
            logStatus(\`Audio metadata loaded. Duration: \${audioPlayer.duration === Infinity ? 'Stream (unknown)' : audioPlayer.duration.toFixed(2) + 's'}\`);
        });
        audioPlayer.addEventListener('canplaythrough', () => {
            logStatus("Audio can play through (enough data buffered for current src).");
        });
        audioPlayer.addEventListener('error', (e) => {
            logStatus(\`Audio player error for src '\${audioPlayer.currentSrc.substring(audioPlayer.currentSrc.length - 50)}': \${audioPlayer.error?.message || 'Unknown error'}\`);
            console.error("Audio element error:", audioPlayer.error, "Current src:", audioPlayer.currentSrc);
            playButton.disabled = false; // Re-enable button on error
        });
         audioPlayer.addEventListener('ended', () => {
            logStatus("Audio playback ended.");
        });

    </script>
</body>
</html>
`
