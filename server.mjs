// backend/server.mjs
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import multer from 'multer';
import path from 'node:path';
import fs from 'fs-extra';
import { fileURLToPath } from 'node:url';
import fsPromises from 'node:fs/promises'; // Import fsPromises for unlink

// --- Import from GoogleAI module ---
import {imageUnderstand } from './AI_ChatBot/GoogleAI.mjs'; // <-- update import

// --- Calculate __dirname equivalent in ESM ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Ensure upload directory exists ---
const uploadDir = path.join(__dirname, 'uploads');
fs.ensureDirSync(uploadDir);
console.log(`[Server] Upload directory ensured at: ${uploadDir}`);

// --- Multer Configuration (Keep as before) ---
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

const imageFileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) {
    console.log(`[Multer] Accepting file: ${file.originalname} (${file.mimetype})`);
    cb(null, true);
  } else {
    console.log(`[Multer] Rejecting file: ${file.originalname} (${file.mimetype}) - Not an image`);
    cb(new Error('仅支持上传图片文件!'), false);
  }
};

const upload = multer({
    storage: storage,
    fileFilter: imageFileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// --- Express App Setup ---
const app = express();
const port = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(express.json());



// --- Routes ---

// Login Route (Keep as is)
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

        const { openid, session_key } = wechatData;
        console.log(`成功获取 openid: ${openid}`);
        res.json({ success: true, message: '登录成功', openid: openid });

    } catch (error) {
        console.error('请求微信 API 时出错:', error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: '请求微信服务时出错' });
    }
});

// --- REMOVE Simple Upload Route ---
// app.post('/api/upload-image', upload.single('homeworkImage'), (req, res, next) => { ... });


// --- Combined Upload and Process Route ---
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
        // Call Gemini image analysis
        const resultText = await imageUnderstand(uploadedFilePath, mimeType);
        // Optionally delete the file after processing
        await fsPromises.unlink(uploadedFilePath);
        res.json({ success: true, reply: resultText }); // <-- change 'result' to 'reply'
    } catch (err) {
        console.error('[Gemini] Error analyzing image:', err);
        // Optionally delete the file on error
        try { await fsPromises.unlink(uploadedFilePath); } catch {}
        res.status(500).json({ success: false, message: 'AI 分析图片时出错', error: err.message });
    }
});


// --- Global Error Handler (Place AFTER routes) ---
// Handles errors specifically from Multer or other middleware *before* the route handler
app.use((err, req, res, next) => {
    console.error("[Global Error Handler] Caught an error:", err);

    if (err instanceof multer.MulterError) {
      console.error("Multer error details:", err);
      let message = `文件上传错误: ${err.code}`;
      if (err.code === 'LIMIT_FILE_SIZE') {
        message = '文件过大，请上传小于 10MB 的图片。';
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        message = '上传字段名不匹配或文件过多。';
      }
      // Return response directly from error handler
      return res.status(400).json({ success: false, message: message });
    } else if (err && err.message === '仅支持上传图片文件!') {
       console.error("File type error:", err.message);
       // Return response directly from error handler
       return res.status(400).json({ success: false, message: err.message });
    } else if (err) {
       console.error("Generic server error:", err);
       // Return response directly from error handler
       return res.status(500).json({ success: false, message: `服务器内部错误: ${err.message || '未知错误'}` });
    }
    // If this middleware didn't handle the error, pass it on
    // (though in this setup, we aim to handle common errors here)
    next(err);
});


// --- Start Server ---
app.listen(port, () => {
    console.log(`后端服务器运行在 http://localhost:${port}`);
    console.log(`Uploads temporary directory: ${uploadDir}`);
    if (!process.env.WX_APP_ID || !process.env.WX_APP_SECRET) {
       console.warn("警告: WX_APP_ID 或 WX_APP_SECRET 未在 .env 文件中配置. 微信登录将失败.");
    }
     if (!process.env.GEMINI_API_KEY) {
       console.warn("警告: GEMINI_API_KEY 未在 .env 文件中配置. AI 功能将不可用.");
    }
});