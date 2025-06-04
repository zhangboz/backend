// backend/server.mjs
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import multer from 'multer';
import path from 'node:path';
import fs from 'fs-extra'; // Using fs-extra for ensureDirSync
import { fileURLToPath } from 'node:url';
import fsPromises from 'node:fs/promises'; // Import fsPromises for unlink

// --- Import from GoogleAI module ---
import { imageUnderstand } from './AI_ChatBot/GoogleAI.mjs';

// --- Import from FileProcessor module ---
import { exportMarkdown, scheduleFileDeletion } from './FileProcessor/fileExport.mjs';

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


// --- Multer Configuration ---
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(safeOriginalName));
  }
});
const customFileFilter = (req, file, cb) => {
  const isImage = file.mimetype.startsWith('image/');
  const isPdf = file.mimetype === 'application/pdf';

  if (isImage || isPdf) {
    console.log(`[Multer] Accepting file: ${file.originalname} (${file.mimetype})`);
    cb(null, true);
  } else {
    console.log(`[Multer] Rejecting file: ${file.originalname} (${file.mimetype}) - Not an image or PDF`);
    cb(new Error('仅支持上传图片或 PDF 文件!'), false);
  }
};
const upload = multer({
    storage: storage,
    fileFilter: customFileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// --- Express App Setup ---
const app = express();
const port = process.env.PORT || 5000;

// --- Middleware ---
app.use(cors());

// Trust proxy for Render's HTTPS redirection
// This makes req.protocol correctly reflect 'https' when behind a proxy.
app.set('trust proxy', 1);

app.use(express.json({ limit: '5mb' })); // Allow larger JSON payloads for markdown
app.use(express.urlencoded({ extended: true, limit: '5mb' })); // For form data if needed

// Middleware to force Content-Disposition: attachment for files in /api/exports
app.use('/api/exports', (req, res, next) => {
    // Get the filename from the URL, e.g., /api/exports/my-document.docx -> my-document.docx
    const filename = path.basename(req.url.split('?')[0]);
    
    // Set the Content-Disposition header to 'attachment' to force download
    // express.static will automatically handle the Content-Type based on the file extension
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    next(); // Pass control to the next middleware (express.static)
});

// Serve temporary exported files statically for download links
app.use('/api/exports', express.static(tempExportDir));


// Login Route
app.post('/api/login', async (req, res) => {
    const { code } = req.body;
    const appId = process.env.WX_APP_ID;
    const appSecret = process.env.WX_APP_SECRET;

    console.log('Received login request with code:', code);

    if (!code) return res.status(400).json({ success: false, message: '缺少 code 参数' });
    if (!appId || !appSecret) {
        console.error('错误: WX_APP_ID 或 WX_APP_SECRET 未在 .env 文件中配置');
        return res.status(500).json({ success: false, message: '服务器配置错误' });
    }

    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${appSecret}&js_code=${code}&grant_type=authorization_code`;

    try {
        const response = await axios.get(url);
        const wechatData = response.data;
        console.log('WeChat API response:', wechatData);

        if (wechatData.errcode && wechatData.errcode !== 0) {
            console.error('微信 API 错误:', wechatData.errmsg);
            return res.status(400).json({ success: false, message: `微信登录失败: ${wechatData.errmsg}`, errcode: wechatData.errcode });
        }

        const { openid, session_key } = wechatData; // session_key might be useful later
        console.log(`成功获取 openid: ${openid}`);
        res.json({ success: true, message: '登录成功', openid: openid });

    } catch (error) {
        console.error('请求微信 API 时出错:', error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: '请求微信服务时出错' });
    }
});

// Combined Upload and Process Route
app.post('/api/process-homework', upload.single('homeworkImage'), async (req, res) => {
    console.log('[Route /api/process-homework] Received request.');

    if (!req.file) {
        console.log('[Route /api/process-homework] No file uploaded or rejected by filter.');
        return res.status(400).json({ success: false, message: '未接收到文件或文件类型不支持' });
    }

    const uploadedFilePath = req.file.path;
    const mimeType = req.file.mimetype;
    console.log(`[Route /api/process-homework] File uploaded: ${uploadedFilePath}, MimeType: ${mimeType}`);

    try {
        const resultText = await imageUnderstand(uploadedFilePath, mimeType);
        await fsPromises.unlink(uploadedFilePath);
        console.log(`[Route /api/process-homework] Deleted uploaded file: ${uploadedFilePath}`);
        res.json({ success: true, reply: resultText });
    } catch (err) {
        console.error('[Gemini] Error analyzing image:', err);
        try {
            await fsPromises.unlink(uploadedFilePath);
            console.log(`[Route /api/process-homework] Deleted uploaded file after error: ${uploadedFilePath}`);
        } catch (unlinkErr) {
            console.error(`[Route /api/process-homework] Failed to delete file after error: ${uploadedFilePath}`, unlinkErr);
        }
        res.status(500).json({ success: false, message: 'AI 分析图片时出错', error: err.message });
    }
});

// Markdown Export Route
app.post('/api/export/:format', async (req, res) => {
    const { format } = req.params;
    const { markdownText } = req.body;

    console.log(`[Route /api/export/${format}] Received request.`);

    if (!markdownText) {
        return res.status(400).json({ success: false, message: 'Markdown text is required in the request body.' });
    }

    const supportedFormats = ['docx', 'pdf'];
    if (!supportedFormats.includes(format.toLowerCase())) {
        return res.status(400).json({ success: false, message: `Unsupported export format: ${format}. Supported: ${supportedFormats.join(', ')}` });
    }

    try {
        const outputFilePath = await exportMarkdown(markdownText, format.toLowerCase());
        const outputFileName = path.basename(outputFilePath);

        console.log(`[Route /api/export/${format}] File generated: ${outputFilePath}`);

        // Provide a Download Link (more robust, allows for temp file management)
        // req.protocol will now correctly be 'https' due to 'trust proxy' setting
        const downloadLink = `${req.protocol}://${req.get('host')}/api/exports/${outputFileName}`;
        res.json({
            success: true,
            message: `File ready for download. It will be available for approximately 5 minutes.`,
            downloadUrl: downloadLink,
            fileName: outputFileName
        });

        // Schedule deletion of the temporary file
        scheduleFileDeletion(outputFilePath, 5 * 60 * 1000); // 5 minutes

    } catch (error) {
        console.error(`[Route /api/export/${format}] Error during export:`, error.message, error.stack);
        res.status(500).json({ success: false, message: `Error exporting to ${format}: ${error.message}` });
    }
});
// app.use(express.static(path.join(__dirname, 'public_react_build')));
// app.get('*', (req, res) => {
//     res.sendFile(path.join(__dirname, 'public_react_build', 'index.html'));
// });

// --- Global Error Handler (Place AFTER routes) ---
app.use((err, req, res, next) => {
    console.error("[Global Error Handler] Caught an error:", err.message, err.stack);

    if (err instanceof multer.MulterError) {
      console.error("Multer error details:", err);
      let message = `文件上传错误: ${err.code}`;
      if (err.code === 'LIMIT_FILE_SIZE') {
        message = '文件过大，请上传小于 10MB 的图片。';
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        message = '上传字段名不匹配或文件过多。';
      }
      return res.status(400).json({ success: false, message: message });
    } else if (err && err.message === '仅支持上传图片或 PDF 文件!') {
       console.error("File type error:", err.message);
       return res.status(400).json({ success: false, message: err.message });
    } else if (res.headersSent) {
        console.log("[Global Error Handler] Headers already sent, delegating to default Express error handler.");
        return next(err);
    }
    else if (err) {
       console.error("Generic server error:", err);
       return res.status(500).json({ success: false, message: `服务器内部错误: ${err.message || '未知错误'}` });
    }
    next(err);
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`Backend server started and listening on port ${port}`);
  console.log(`Uploads temporary directory: ${uploadDir}`);
  console.log(`Exports temporary directory served at /api/exports from: ${tempExportDir}`);
  if (!process.env.WX_APP_ID || !process.env.WX_APP_SECRET) {
     console.warn("警告: WX_APP_ID 或 WX_APP_SECRET 未配置. 微信登录将失败.");
  }
   if (!process.env.GEMINI_API_KEY) {
     console.warn("警告: GEMINI_API_KEY 未配置. AI 功能将不可用.");
  }
});