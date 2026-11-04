import express from 'express';
import { getExportQueue } from '../FileProcessor/queue.mjs';
import { validateExportInput } from '../FileProcessor/fileExport.mjs';
import {
  existingExportPath, signedDownloadUrl, verifyDownload,
} from '../FileProcessor/localExports.mjs';

// BullMQ persists Error.message, but older jobs may contain raw converter
// diagnostics (including document text). Only translate exact known messages.
const safeFailureMessages = new Map([
  ['Embedded images are not supported in document exports.',
    'Document export does not support embedded images. Remove the image and try again.'],
  ['PDF conversion requires XeLaTeX on PATH.',
    'PDF export requires XeLaTeX. Install it and try again, or export as Word.'],
  ['The configured PDF font is unavailable. Check PDF_CJK_FONT.',
    'The PDF font is unavailable. Check the server font configuration or export as Word.'],
  ['PDF conversion could not render the document’s mathematical formatting.',
    'PDF conversion could not render the mathematical formatting. Try exporting as Word.'],
  ['Document conversion timed out. Please try a shorter document.',
    'Document conversion timed out. Please try a shorter document.'],
  ['Pandoc is not installed or is not on PATH.',
    'Document export requires Pandoc. Install it and try again.'],
  ['Could not start the document converter.',
    'The document converter could not start. Please check the local server and try again.'],
  ['Could not send the document to the converter.',
    'The document converter stopped unexpectedly. Please try again.'],
]);
const fallbackFailureMessage = 'Document conversion failed. Please try again or choose another export format.';

export function createExportRouter(options = {}) {
  const router = express.Router();
  const queueProvider = options.queueProvider || getExportQueue;
  const now = options.now || Date.now;

  router.post('/:format', async (req, res, next) => {
    try {
      const targetFormat = req.params.format.toLowerCase();
      const markdownText = req.body?.markdownText;
      validateExportInput(markdownText, targetFormat);
      if (!req.user?.user_id) return res.status(401).json({ success: false, message: 'Authentication required.' });
      const queue = await queueProvider();
      const job = await queue.add('convert-file', { markdownText, targetFormat, userId: req.user.user_id });
      res.status(202).json({ success: true, message: 'Your document conversion has been queued.', jobId: job.id });
    } catch (error) {
      next(error);
    }
  });

  router.get('/status/:jobId', async (req, res, next) => {
    try {
      const queue = await queueProvider();
      const job = await queue.getJob(req.params.jobId);
      if (!req.user?.user_id || !job?.data?.userId || String(job.data.userId) !== String(req.user.user_id)) {
        return res.status(404).json({ success: false, message: 'Job not found.' });
      }
      const state = await job.getState();
      if (state === 'completed') {
        const result = job.returnvalue;
        const expires = Date.parse(result?.expiresAt);
        const filePath = await existingExportPath(result?.fileName, options.exportDir);
        if (!Number.isFinite(expires) || expires <= now() || !filePath) {
          return res.json({ success: true, jobId: job.id, state: 'expired', result: null,
            message: 'This download has expired. Please export the document again.' });
        }
        return res.json({ success: true, jobId: job.id, state, result: {
          fileName: result.fileName,
          expiresAt: result.expiresAt,
          downloadUrl: signedDownloadUrl(result, options),
        } });
      }
      res.json({ success: true, jobId: job.id, state, result: null,
        ...(state === 'failed' ? { message: safeFailureMessages.get(job.failedReason) || fallbackFailureMessage } : {}),
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}

/** Mount at /api/export/download before subscription middleware; the URL is a short-lived capability. */
export function createDownloadRouter(options = {}) {
  const router = express.Router();
  router.get('/:fileName', async (req, res, next) => {
    try {
      const valid = verifyDownload(req.params.fileName, req.query.expires, req.query.signature, {
        ...options, now: options.now ? options.now() : Date.now(),
      });
      if (!valid) return res.status(403).json({ success: false, message: 'Invalid or expired download link.' });
      const filePath = await existingExportPath(req.params.fileName, options.exportDir);
      if (!filePath) return res.status(404).json({ success: false, message: 'This export is no longer available.' });
      res.setHeader('Cache-Control', 'private, no-store');
      res.download(filePath, req.params.fileName, { lastModified: false }, (error) => {
        if (error && !res.headersSent) next(error);
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}

export const downloadRouter = createDownloadRouter();
export default createExportRouter();
