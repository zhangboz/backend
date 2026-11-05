import express from 'express';
import { openaiExports, validateExportInput, exportFailureMessage } from '../services/openaiExports.mjs';
import { signedDownloadUrl, verifyDownload } from '../services/exportDownloads.mjs';

export function createExportRouter(options = {}) {
  const router = express.Router();
  const service = options.service || openaiExports;
  const now = options.now || Date.now;
  router.post('/:format', async (req, res, next) => {
    try {
      const format = req.params.format.toLowerCase();
      validateExportInput(req.body?.markdownText, format);
      if (!req.user?.user_id) return res.status(401).json({ success: false, message: 'Authentication required.' });
      const job = await service.create({ userId: req.user.user_id, format,
        markdownText: req.body.markdownText, requestKey: req.get('Idempotency-Key') });
      res.status(202).json({ success: true, message: 'Your document is being generated.', jobId: job.id });
    } catch (error) { next(error); }
  });
  router.get('/status/:jobId', async (req, res, next) => {
    try {
      if (!req.user?.user_id) return res.status(404).json({ success: false, message: 'Job not found.' });
      const job = await service.status(req.params.jobId, req.user.user_id);
      if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });
      res.setHeader('Cache-Control', 'private, no-store');
      let state = job.state;
      if (state === 'completed' && Date.parse(job.downloadExpiresAt) <= now()) state = 'expired';
      const result = state === 'completed' ? { fileName: job.fileName, expiresAt: job.downloadExpiresAt,
        downloadUrl: signedDownloadUrl({ fileName: job.fileName, expiresAt: job.downloadExpiresAt }, options) } : null;
      res.json({ success: true, jobId: job.id, state, result,
        ...(state === 'failed' ? { message: exportFailureMessage(job.errorCode) } : {}),
        ...(state === 'expired' ? { message: 'This export has expired. Please generate it again.' } : {}),
        ...(job.warning ? { message: job.warning } : {}),
      });
    } catch (error) { next(error); }
  });
  return router;
}

// A short-lived signed capability, issued only after an authenticated owner check.
export function createDownloadRouter(options = {}) {
  const router = express.Router();
  const service = options.service || openaiExports;
  router.get('/:fileName', async (req, res, next) => {
    try {
      if (!verifyDownload(req.params.fileName, req.query.expires, req.query.signature, {
        ...options, now: options.now ? options.now() : Date.now(),
      })) return res.status(403).json({ success: false, message: 'Invalid or expired download link.' });
      const job = await service.findByFileName(req.params.fileName);
      if (!job?.content || job.fileName !== req.params.fileName || !['pdf', 'docx'].includes(job.format) ||
          !job.fileName.endsWith('.' + job.format) || Date.parse(job.downloadExpiresAt) !== Number(req.query.expires)) {
        return res.status(404).json({ success: false, message: 'This export is no longer available.' });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.attachment(job.fileName);
      res.type(job.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.send(job.content);
    } catch (error) { next(error); }
  });
  return router;
}
export const downloadRouter = createDownloadRouter();
export default createExportRouter();
