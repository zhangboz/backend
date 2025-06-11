// backend/routes/processHomeworkRouter.mjs
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fsPromises from 'node:fs/promises';

// --- Import from GoogleAI module ---
import { imageUnderstand } from '../AI_ChatBot/GoogleAI_Agent.mjs'; // Adjusted path

// This function creates and returns the router, configured with uploadDir
export default function createProcessHomeworkRouter(uploadDir) {
    const router = express.Router();

    // --- Multer Configuration ---
    const storage = multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, uploadDir); // Use the passed uploadDir from server.mjs
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
            console.log(`[Multer - ProcessHomeworkRouter] Accepting file: ${file.originalname} (${file.mimetype})`);
            cb(null, true);
        } else {
            console.log(`[Multer - ProcessHomeworkRouter] Rejecting file: ${file.originalname} (${file.mimetype}) - Not an image or PDF`);
            cb(new Error('仅支持上传图片或 PDF 文件!'), false); // This error will be caught by the global error handler
        }
    };

    const upload = multer({
        storage: storage,
        fileFilter: customFileFilter,
        limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
    });

    // Process Homework Route
    // Mounted at /api/process-homework, so this handles POST to that path
    router.post('/', upload.single('homeworkImage'), async (req, res, next) => {
        console.log('[ProcessHomework Router] Received request.');

        if (!req.file) {
            console.log('[ProcessHomework Router] No file uploaded or rejected by filter.');
            return res.status(400).json({ success: false, message: '未接收到文件或文件类型不支持' });
        }

        const uploadedFilePath = req.file.path;
        const mimeType = req.file.mimetype;
        console.log(`[ProcessHomework Router] File uploaded: ${uploadedFilePath}, MimeType: ${mimeType}`);

        try {
            // Call imageUnderstand and get the object with text1 and text2
            const agentResponses = await imageUnderstand(uploadedFilePath, mimeType);

            await fsPromises.unlink(uploadedFilePath);
            console.log(`[ProcessHomework Router] Deleted uploaded file: ${uploadedFilePath}`);

            // Send both texts in the JSON response
            res.json({
                success: true,
                reply1: agentResponses.text1, // Use text1 from the returned object
                reply2: agentResponses.text2  // Use text2 from the returned object
            });
        } catch (analysisError) {
            console.error('[ProcessHomework Router - Agent] Error analyzing image:', analysisError.message);
            if (uploadedFilePath) {
                try {
                    await fsPromises.unlink(uploadedFilePath);
                    console.log(`[ProcessHomework Router] Deleted uploaded file after error: ${uploadedFilePath}`);
                } catch (unlinkErr) {
                    console.error(`[ProcessHomework Router] Failed to delete file after error: ${uploadedFilePath}`, unlinkErr);
                }
            }
            const errorForClient = new Error('AI 分析图片时出错');
            errorForClient.detailsForLog = analysisError.message;
            errorForClient.statusCode = 500;
            next(errorForClient);
        }
    });

    return router;
}