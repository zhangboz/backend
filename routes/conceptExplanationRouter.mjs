import express from 'express';
import jwt from 'jsonwebtoken';
import { AIError, safeAIError } from '../AI_ChatBot/openaiClient.mjs';
import { createConceptExplainer } from '../AI_ChatBot/conceptExplanation.mjs';
import { conceptStore } from '../services/conceptSessions.mjs';
import { limitAI } from '../middleware/aiLimits.mjs';

function identities(req) {
  const values = [];
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.user_id) values.push('user:' + decoded.user_id);
    } catch { /* Anonymous result capabilities remain usable after a login expires. */ }
  }
  const anonymousId = req.body?.anonymousId ?? req.query?.anonymousId;
  if (typeof anonymousId === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(anonymousId)) values.push('anonymous:' + anonymousId);
  if (!values.length) throw new AIError('A valid login or anonymous identity is required.', 400, 'MISSING_IDENTITY');
  return values;
}

export default function createConceptExplanationRouter({ store = conceptStore,
  explainer = { explain: createConceptExplainer() }, limiter = limitAI } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  function runTurn(req, res, next, sessionId, initial) {
    let ticket;
    try {
      ticket = store.reserve({ sessionId, identities: identities(req), message: req.body?.message, initial });
      // Hard limits/refusals never enter the model/rate-limiter path.
      if (ticket.snapshot) return res.json(ticket.snapshot);
    } catch (error) { return next(safeAIError(error)); }

    const cleanup = () => {
      req.removeListener('aborted', cleanup);
      res.removeListener('close', cleanup);
      res.removeListener('finish', cleanup);
      store.release(ticket);
    };
    req.once('aborted', cleanup);
    res.once('close', cleanup);
    res.once('finish', cleanup);
    // A rejected limiter response also fires finish and releases the reservation.
    limiter(req, res, async () => {
      try {
        ticket.controller.signal.throwIfAborted();
        const result = await explainer.explain(ticket.args);
        const response = store.complete(ticket, result);
        if (!res.destroyed) res.json(response);
      } catch (error) {
        if (!res.destroyed && !res.writableEnded) next(safeAIError(error));
      } finally { cleanup(); }
    });
  }

  router.post('/start', (req, res, next) => {
    try {
      // Replacement happens before any rate limiting or asynchronous model work.
      const sessionId = store.begin({ ...req.body, identities: identities(req) });
      runTurn(req, res, next, sessionId, true);
    } catch (error) { next(safeAIError(error)); }
  });
  router.post('/:sessionId/messages', (req, res, next) => runTurn(req, res, next, req.params.sessionId, false));
  router.get('/:sessionId/export', (req, res, next) => {
    try { res.json(store.exportContext(req.params.sessionId, identities(req))); }
    catch (error) { next(safeAIError(error)); }
  });
  router.delete('/channel', (req, res, next) => {
    try {
      store.closeChannel({ ...req.body, identities: identities(req) });
      res.sendStatus(204);
    } catch (error) { next(safeAIError(error)); }
  });
  return router;
}
