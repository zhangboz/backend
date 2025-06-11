// backend/routes/speechRouter.mjs
import express from 'express';
import { generateAndStreamAudio } from '../AI_ChatBot/text_speech.mjs'; // Path relative to routes/

const router = express.Router();

/**
 * @route   POST /api/speech
 * @desc    Generates audio from text and streams it back.
 * @access  Public (or protected, depending on your auth setup)
 * @body    { "text": "String of text to convert to speech", "voice": "OptionalVoiceName" }
 */
router.post('/', async (req, res, next) => {
    const { text, voice } = req.body; // 'voice' is optional
    console.log('[SpeechRouter] Received request to generate speech, with text:', text, 'and voice:', voice);
    // Validate that 'text' is provided and is a non-empty string
    if (!text || typeof text !== 'string' || text.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            message: 'Request body must contain a non-empty "text" string.' 
        });
    }

    try {
        // generateAndStreamAudio is an async function that handles sending the
        // HTTP response (audio stream or error JSON) directly.
        // We await it here to ensure that if it throws an unhandled error
        // (one not resulting in an HTTP response sent by itself),
        // it's caught and passed to the global error handler.
        await generateAndStreamAudio(req, res, text, voice);
    } catch (error) {
        // This catch block is a safety net for unexpected errors within generateAndStreamAudio
        // that it doesn't handle by sending a response itself.
        console.error('[SpeechRouter] Error during call to generateAndStreamAudio. Forwarding to global error handler:', error);
        next(error); // Pass the error to the global error handler in server.mjs
    }
});

export default router;