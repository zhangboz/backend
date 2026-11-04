import express from 'express';
import { generateAndStreamAudio } from '../AI_ChatBot/text_speech.mjs';
import { safeAIError } from '../AI_ChatBot/openaiClient.mjs';
import { limitAI } from '../middleware/aiLimits.mjs';

const router = express.Router();
router.post('/', limitAI, async (req, res, next) => {
  try {
    await generateAndStreamAudio(req, res, req.body?.text, req.body?.voice);
  } catch (error) {
    if (!res.destroyed) next(safeAIError(error));
  }
});
export default router;
