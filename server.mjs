// backend/server.mjs
import 'dotenv/config'; // Must be first
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'fs-extra'; // Using fs-extra for ensureDirSync
import { fileURLToPath } from 'node:url';
import multer from 'multer'; // Import multer for using MulterError in global error handler
import passport from 'passport'; // <-- Import Passport
import session from 'express-session'; // <-- Import express-session
import { requireAuth, requireSubscription } from './middleware/auth.mjs';

// --- Import Routers ---
import loginRouter from './routes/loginRouter.mjs';
import createProcessHomeworkRouter from './routes/processHomeworkRouter.mjs';
import exportRouter from './routes/exportRouter.mjs';
import speechRouter from './routes/speechRouter.mjs';
import webhookRouter from './routes/webhookRouter.mjs';
import paymentRouter from './routes/paymentRouter.mjs';
import userStatusRouter from './routes/userStatusRouter.mjs';

// --- Calculate __dirname equivalent in ESM ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Ensure upload and temp_exports directories exist ---
const uploadDir = path.join(__dirname, 'uploads');
fs.ensureDirSync(uploadDir);
console.log(`[Server] Upload directory ensured at: ${uploadDir}`);

const tempExportDir = path.join(__dirname, 'temp_exports'); // Directory for Pandoc outputs
fs.ensureDirSync(tempExportDir);
console.log(`[Server] Temporary export directory ensured at: ${tempExportDir}`);

// --- Express App Setup ---
const app = express();
const port = process.env.PORT || 5000;

// --- Core Middleware ---
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000', // Be specific in production
  credentials: true
}));
app.set('trust proxy', 1); // Trust proxy for Render's HTTPS redirection
// Raw body parser for Stripe webhook
app.use('/api/payment/webhook', express.raw({type: 'application/json'}), webhookRouter);

app.use(express.json({ limit: '5mb' })); // Allow larger JSON payloads for markdown
app.use(express.urlencoded({ extended: true, limit: '5mb' })); // For form data

// --- Session and Passport Middleware (NEEDS TO BE BEFORE ROUTES) ---
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false, // Don't create session until something stored
    cookie: {
      // secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
      // httpOnly: true,
      // sameSite: 'lax'
    }
}));
app.use(passport.initialize());
app.use(passport.session());


// --- Static File Serving for Exports with Download Force ---
app.use('/api/exports', (req, res, next) => {
    const filename = path.basename(req.path);
    if (filename && filename !== '.' && filename !== '/') {
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    next();
});
app.use('/api/exports', express.static(tempExportDir));


// --- Mount Routers ---
// 1. public routes
app.use('/api/login', loginRouter);
const processHomeworkRouter = createProcessHomeworkRouter(uploadDir);
app.use('/api/process-homework', processHomeworkRouter); // PUBLIC ROUTE

// 2. authenticated routes
app.use('/api/payment', requireAuth, paymentRouter);
app.use('/api/user/status', requireAuth, userStatusRouter);

// 3. subscription-required routes
app.use('/api/export', requireAuth, requireSubscription, exportRouter);
app.use('/api/speech', requireAuth, requireSubscription, speechRouter);


// --- Global Error Handler (Place AFTER all routes and middleware) ---
app.use((err, req, res, next) => {
    console.error("[Global Error Handler] Caught an error:", err.message);
    if (err.stack) {
        console.error(err.stack);
    }
    if (err.detailsForLog) {
        console.error("[Global Error Handler] Additional error details:", err.detailsForLog);
    }

    if (err instanceof multer.MulterError) {
      console.error("Multer error details:", err.code);
      let message = `文件上传错误: ${err.code}`;
      if (err.code === 'LIMIT_FILE_SIZE') {
        message = '文件过大，请上传小于 10MB 的图片。';
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        message = '上传字段名不匹配或文件过多。';
      }
      return res.status(400).json({ success: false, message: message });
    } else if (err && err.message === '仅支持上传图片或 PDF 文件!') {
       console.error("File type error (from customFileFilter):", err.message);
       return res.status(400).json({ success: false, message: err.message });
    } else if (res.headersSent) {
        console.log("[Global Error Handler] Headers already sent, delegating to Express default.");
        return next(err);
    }
    else if (err) {
       const statusCode = err.statusCode || 500;
       return res.status(statusCode).json({ success: false, message: err.message || '服务器内部错误' });
    }

    if (!res.headersSent) {
      res.status(500).json({ success: false, message: '服务器发生未知错误' });
    }
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`Backend server started and listening on port ${port}`);
});