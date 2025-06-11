// backend/server.mjs
import 'dotenv/config'; // Must be first
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'fs-extra'; // Using fs-extra for ensureDirSync
import { fileURLToPath } from 'node:url';
import multer from 'multer'; // Import multer for using MulterError in global error handler

// --- Import Routers ---
import loginRouter from './routes/loginRouter.mjs';
import createProcessHomeworkRouter from './routes/processHomeworkRouter.mjs';
import exportRouter from './routes/exportRouter.mjs';
import speechRouter from './routes/speechRouter.mjs'; // <--- ADD THIS LINE

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
app.use(cors());
app.set('trust proxy', 1); // Trust proxy for Render's HTTPS redirection
app.use(express.json({ limit: '5mb' })); // Allow larger JSON payloads for markdown
app.use(express.urlencoded({ extended: true, limit: '5mb' })); // For form data

// --- Static File Serving for Exports with Download Force ---
// This middleware sets Content-Disposition for files served from /api/exports
app.use('/api/exports', (req, res, next) => {
    const filename = path.basename(req.path); // req.path is URL path part, no query string
    
    // Ensure it's a valid filename and not just '/' or '.'
    if (filename && filename !== '.' && filename !== '/') {
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    next();
});
// Serve temporary exported files statically from tempExportDir for download links
app.use('/api/exports', express.static(tempExportDir));


// --- Mount Routers ---
app.use('/api/login', loginRouter);

// Create and mount the processHomeworkRouter, passing the configured uploadDir
const processHomeworkRouter = createProcessHomeworkRouter(uploadDir);
app.use('/api/process-homework', processHomeworkRouter);

app.use('/api/export', exportRouter);
app.use('/api/speech', speechRouter); 

// --- Optional: Static serving for a React build ---
// app.use(express.static(path.join(__dirname, 'public_react_build')));
// app.get('*', (req, res) => {
//     res.sendFile(path.join(__dirname, 'public_react_build', 'index.html'));
// });

// --- Global Error Handler (Place AFTER all routes and middleware) ---
app.use((err, req, res, next) => {
    console.error("[Global Error Handler] Caught an error:", err.message);
    if (err.stack) {
        console.error(err.stack);
    }
    if (err.detailsForLog) { // Custom property for more detailed server-side logging
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
    } else if (err && err.message === '仅支持上传图片或 PDF 文件!') { // Error from customFileFilter
       console.error("File type error (from customFileFilter):", err.message);
       return res.status(400).json({ success: false, message: err.message });
    } else if (res.headersSent) {
        // If headers already sent, delegate to default Express error handler
        console.log("[Global Error Handler] Headers already sent, delegating to Express default.");
        return next(err);
    }
    // For other errors passed via next(err) or unhandled exceptions in route handlers
    else if (err) {
       const statusCode = err.statusCode || 500;
       // Send err.message (client-facing message) to the client
       return res.status(statusCode).json({ success: false, message: err.message || '服务器内部错误' });
    }
    
    // Fallback if no specific error handling caught it and headers not sent
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: '服务器发生未知错误' });
    }
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`Backend server started and listening on port ${port}`);
  if (!process.env.WX_APP_ID || !process.env.WX_APP_SECRET) {
     console.warn("警告: WX_APP_ID 或 WX_APP_SECRET 未配置. 微信登录将失败.");
  }
   if (!process.env.GEMINI_API_KEY) {
     console.warn("警告: GEMINI_API_KEY 未配置. AI 功能将不可用.");
  }
});