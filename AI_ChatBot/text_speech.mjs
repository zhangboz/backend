import { GoogleGenAI } from '@google/genai';
import wav from 'wav';
import { createHash } from 'node:crypto';

async function generateAndStreamAudio(req, res, textToSpeak, voiceName = 'Kore') {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    try {
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
        const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!data) {
            throw new Error('No audio data received from API');
        }
        const pcmData = Buffer.from(data, 'base64');
        const channels = 1;
        const sampleRate = 24000; 
        const bitDepth = 16;

        const etag = `W/"${createHash('md5').update(textToSpeak).digest('hex')}"`;
        
        if (req.headers['if-none-match'] === etag) {
            res.setHeader('ETag', etag);
            res.writeHead(304);
            res.end();
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

        wavWriter.pipe(res);
        wavWriter.write(pcmData);
        wavWriter.end(() => {
        });

        wavWriter.on('error', (err) => {
            console.error('[Server] Error during WAV writing/streaming:', err); // Kept: Error handler
            if (!res.headersSent) {
                try {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'WAV streaming error' }));
                } catch (e) {
                    console.error("[Server] Error sending error response:", e); // Kept: Error handler
                }
            } else if (!res.writableEnded) {
                res.end();
            }
        });

    } catch (error) {
        console.error('[Server] Error generating audio stream:', error); // Kept: Error handler
        if (!res.headersSent) {
            try {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to generate audio', details: error.message }));
            } catch (e) {
                console.error("[Server] Error sending error response:", e); // Kept: Error handler
            }
        } else if (!res.writableEnded) {
            res.end();
        }
    }
}

export { generateAndStreamAudio };
// This module exports a function to generate and stream audio using the Gemini API.