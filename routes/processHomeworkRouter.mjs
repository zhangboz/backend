// backend/routes/processHomeworkRouter.mjs
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import jwt from 'jsonwebtoken'; // Import jwt to verify tokens

// --- Import from GoogleAI module ---
// MODIFICATION: Import both functions from the agent module
import { imageUnderstand, handWrittenToMarkdown } from '../AI_ChatBot/GoogleAI_Agent.mjs'; // Adjusted path

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
            cb(new Error('Only image or pdf files are supported!'), false); // This error will be caught by the global error handler
        }
    };

    const upload = multer({
        storage: storage,
        fileFilter: customFileFilter,
        limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
    });

    // Process Homework Route (Original: Solves problems)
    router.post('/', upload.single('homeworkImage'), async (req, res, next) => {
        console.log('[ProcessHomework Router] Received request.');

        if (!req.file) {
            console.log('[ProcessHomework Router] No file uploaded or rejected by filter.');
            return res.status(400).json({ success: false, message: 'File not recieved or format not supported.' });
        }

        const uploadedFilePath = req.file.path;
        const mimeType = req.file.mimetype;
        const language = req.body.language || 'en';
        
        // --- DYNAMIC USER ID LOGIC ---
        let aiUserId = null;
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (token) {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                if (decoded.user_id) {
                    aiUserId = `image_user_${decoded.user_id}`;
                }
            } catch (err) {
                console.warn(`[ProcessHomework Router] Invalid auth token provided. Treating as anonymous. Error: ${err.message}`);
            }
        }
        
        if (!aiUserId && req.body.anonymousId) {
            const sanitizedAnonymousId = String(req.body.anonymousId).replace(/[^a-zA-Z0-9-]/g, '');
            aiUserId = `anon_user_${sanitizedAnonymousId}`;
        }

        if (!aiUserId) {
            const err = new Error('User identity could not be determined, request aborted.');
            err.statusCode = 400;
            console.error('[ProcessHomework Router] Critical: Could not determine user ID from token or anonymousId.');
            return next(err);
        }
        // --- END DYNAMIC USER ID LOGIC ---

        console.log(`[ProcessHomework Router] File uploaded: ${uploadedFilePath}, MimeType: ${mimeType}, Final AI_UserID: ${aiUserId}, Language: ${language}`);

        try {
            const agentResponses = await imageUnderstand(uploadedFilePath, mimeType, aiUserId, language);

            await fsPromises.unlink(uploadedFilePath);
            console.log(`[ProcessHomework Router] Deleted uploaded file: ${uploadedFilePath}`);

            res.json({
                success: true,
                reply1: agentResponses.text1,
                reply2: agentResponses.text2
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
            const errorForClient = new Error('AI cached error in analyzing the image');
            errorForClient.detailsForLog = analysisError.message;
            errorForClient.statusCode = 500;
            next(errorForClient);
        }
    });

    // --- NEW ROUTE for Handwriting to Markdown ---
    router.post('/hand-to-markdown', upload.single('homeworkImage'), async (req, res, next) => {
        console.log('[ProcessHomework Router /hand-to-markdown] Received request.');

        if (!req.file) {
            console.log('[ProcessHomework Router /hand-to-markdown] No file uploaded or rejected by filter.');
            return res.status(400).json({ success: false, message: 'File not recieved or format not supported.' });
        }

        const uploadedFilePath = req.file.path;
        const mimeType = req.file.mimetype;

        // DYNAMIC USER ID LOGIC - copied from the original route
        let aiUserId = null;
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (token) {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                if (decoded.user_id) {
                    aiUserId = `image_user_${decoded.user_id}`;
                }
            } catch (err) {
                console.warn(`[ProcessHomework Router] Invalid auth token provided. Treating as anonymous. Error: ${err.message}`);
            }
        }
        
        if (!aiUserId && req.body.anonymousId) {
            const sanitizedAnonymousId = String(req.body.anonymousId).replace(/[^a-zA-Z0-9-]/g, '');
            aiUserId = `anon_user_${sanitizedAnonymousId}`;
        }

        if (!aiUserId) {
            const err = new Error('User identity could not be determined, request aborted.');
            err.statusCode = 400;
            console.error('[ProcessHomework Router] Critical: Could not determine user ID from token or anonymousId.');
            return next(err);
        }

        console.log(`[ProcessHomework Router /hand-to-markdown] File uploaded: ${uploadedFilePath}, MimeType: ${mimeType}, Final AI_UserID: ${aiUserId}`);

        try {
            // Call the new agent function
            const agentResponse = await handWrittenToMarkdown(uploadedFilePath, mimeType, aiUserId);

            await fsPromises.unlink(uploadedFilePath);
            console.log(`[ProcessHomework Router /hand-to-markdown] Deleted uploaded file: ${uploadedFilePath}`);

            // Send only reply1 in the JSON response, as reply2 does not exist for this agent
            res.json({
                success: true,
                reply1: agentResponse.text1,
            });
        } catch (analysisError) {
            console.error('[ProcessHomework Router /hand-to-markdown - Agent] Error analyzing image:', analysisError.message);
            if (uploadedFilePath) {
                try {
                    await fsPromises.unlink(uploadedFilePath);
                    console.log(`[ProcessHomework Router] Deleted uploaded file after error: ${uploadedFilePath}`);
                } catch (unlinkErr) {
                    console.error(`[ProcessHomework Router] Failed to delete file after error: ${uploadedFilePath}`, unlinkErr);
                }
            }
            const errorForClient = new Error('AI cached error in analyzing the image');
            errorForClient.detailsForLog = analysisError.message;
            errorForClient.statusCode = 500;
            next(errorForClient);
        }
    });

    return router;
}