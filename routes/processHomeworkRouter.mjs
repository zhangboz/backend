import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import jwt from 'jsonwebtoken';
import { imageUnderstand, handWrittenToMarkdown, supportedMimeTypes } from '../AI_ChatBot/OpenAI_Agent.mjs';
import { AIError, safeAIError } from '../AI_ChatBot/openaiClient.mjs';
import { limitAI } from '../middleware/aiLimits.mjs';
import { conceptStore } from '../services/conceptSessions.mjs';

function identity(req) {
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.user_id) return 'user:' + decoded.user_id;
    } catch { /* A public request may still supply an anonymous identity. */ }
  }
  const anonymousId = typeof req.body?.anonymousId === 'string' ? req.body.anonymousId : '';
  if (/^[a-zA-Z0-9-]{1,128}$/.test(anonymousId)) return 'anonymous:' + anonymousId;
  throw new AIError('A valid login or anonymous identity is required.', 400, 'MISSING_IDENTITY');
}

export default function createProcessHomeworkRouter(uploadDir, service = { imageUnderstand, handWrittenToMarkdown }, contextStore = conceptStore) {
  const router = express.Router();
  const upload = multer({
    storage: multer.diskStorage({ destination: uploadDir, filename: (_req, _file, cb) => cb(null, randomUUID()) }),
    fileFilter: (_req, file, cb) => supportedMimeTypes.has(file.mimetype)
      ? cb(null, true)
      : cb(new AIError('Upload a PNG, JPEG, WebP, GIF or PDF file.', 400, 'INVALID_FILE_TYPE')),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 3, fieldSize: 1024 },
  });

  const processFile = handwritten => async (req, res, next) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', cancel);
    res.once('close', cancel);
    try {
      if (!req.file) throw new AIError('Upload an image or PDF file.', 400, 'MISSING_FILE');
      const userId = identity(req);
      const language = req.body?.language || 'en';
      const result = handwritten
        ? await service.handWrittenToMarkdown(req.file.path, req.file.mimetype, userId, { signal: controller.signal })
        : await service.imageUnderstand(req.file.path, req.file.mimetype, userId, language, { signal: controller.signal });
      if (!controller.signal.aborted && !res.destroyed) {
        const explanationContextId = !handwritten && result.explanationContext
          ? contextStore.registerResult({ ...result.explanationContext, owner: userId }) : null;
        res.json({ success: true, reply1: result.text1,
          ...(!handwritten ? { reply2: result.text2 ?? null } : {}),
          ...(explanationContextId ? { explanationContextId } : {}),
          ...(result.warning ? { warning: result.warning } : {}),
        });
      }
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) next(safeAIError(error));
    } finally {
      req.removeListener('aborted', cancel);
      res.removeListener('close', cancel);
      if (req.file?.path) await unlink(req.file.path).catch(() => {});
    }
  };
  router.post('/', limitAI, upload.single('homeworkImage'), processFile(false));
  router.post('/hand-to-markdown', limitAI, upload.single('homeworkImage'), processFile(true));
  return router;
}
