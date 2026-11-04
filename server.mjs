import './config.mjs';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import passport from 'passport';
import { createOAuthSession, OAUTH_SESSION_PATH } from './services/oauthSession.mjs';
import { trustProxyHops } from './services/runtimeConfig.mjs';
import { requireAuth, requireSubscription, requireAdmin } from './middleware/auth.mjs';
import loginRouter from './routes/loginRouter.mjs';
import createProcessHomeworkRouter from './routes/processHomeworkRouter.mjs';
import exportRouter, { downloadRouter } from './routes/exportRouter.mjs';
import speechRouter from './routes/speechRouter.mjs';
import webhookRouter from './routes/webhookRouter.mjs';
import paymentRouter from './routes/paymentRouter.mjs';
import userStatusRouter from './routes/userStatusRouter.mjs';
import adminRouter from './routes/adminRouter.mjs';
import db from './db.mjs';
import { getExportQueue, closeExportQueue } from './FileProcessor/queue.mjs';

const uploadDir = fileURLToPath(new URL('./uploads', import.meta.url));
fs.mkdirSync(uploadDir, { recursive: true });
const bounded = (promise) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Dependency timeout')), 2500);
  })]).finally(() => clearTimeout(timer));
};
export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', trustProxyHops());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }));
app.use('/api/payment/webhook', express.raw({ type: 'application/json', limit: '1mb' }), webhookRouter);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
const oauthSession = createOAuthSession();
app.use(OAUTH_SESSION_PATH, oauthSession.middleware);
app.use(passport.initialize());
app.get('/api/health', async (_req, res) => {
  const checks = await Promise.allSettled([
    bounded(db.query('SELECT 1')),
    bounded(getExportQueue().then(async queue => (await queue.client).ping())),
    bounded(getExportQueue().then(queue => queue.getWorkers())),
    bounded(oauthSession.healthy()),
  ]);
  const dependencies = {
    database: checks[0].status === 'fulfilled', redis: checks[1].status === 'fulfilled',
    exportWorker: checks[2].status === 'fulfilled' && checks[2].value.length > 0,
    sessionStore: checks[3].status === 'fulfilled' && checks[3].value === true,
  };
  const healthy = Object.values(dependencies).every(Boolean);
  res.status(healthy ? 200 : 503).json({ healthy, dependencies });
});
app.use('/api/login', loginRouter);
app.use('/api/process-homework', createProcessHomeworkRouter(uploadDir));
app.all('/api/gcs-webhook', (_req, res) => res.status(410).json({ message: 'Textbook cloud processing is paused.' }));
app.use('/api/export/download', downloadRouter);
app.use('/api/payment', requireAuth, paymentRouter);
app.use('/api/user', requireAuth, userStatusRouter);
app.use('/api/admin', requireAuth, requireAdmin, adminRouter);
app.use('/api/export', requireAuth, requireSubscription, exportRouter);
app.use('/api/speech', requireAuth, requireSubscription, speechRouter);
app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ success: false,
    message: err.code === 'LIMIT_FILE_SIZE' ? 'Please upload an image or PDF smaller than 10 MB.' : 'Invalid upload field or too many files.' });
  const status = err.statusCode || err.status || 500;
  console.error(JSON.stringify({ event: 'request_error', status, code: err.code || 'request_failed' }));
  res.status(status).json({ success: false, code: err.code || 'REQUEST_FAILED', message: status < 500 || err.expose
    ? err.message : 'The request could not be completed. Please try again.' });
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required in backend/.env.');
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 5000);
  const server = app.listen(port, host, () => console.log(`Backend listening at http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await new Promise(resolve => {
      const timer = setTimeout(() => { server.closeAllConnections(); resolve(); }, 10000);
      server.close(() => { clearTimeout(timer); resolve(); });
      server.closeIdleConnections();
    });
    await Promise.allSettled([db.end(), closeExportQueue(), oauthSession.close()]);
    process.exit(0);
  });
}
