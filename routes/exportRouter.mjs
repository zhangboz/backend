// backend/routes/exportRouter.mjs
import express from 'express';
import path from 'node:path';

// --- Import from FileProcessor module ---
import { exportMarkdown, scheduleFileDeletion } from '../FileProcessor/fileExport.mjs'; // Adjusted path

const router = express.Router();

// Markdown Export Route (e.g., POST /api/export/docx)
// Mounted at /api/export, so this handles POST to /:format
router.post('/:format', async (req, res, next) => { // Added next for error handling
    const { format } = req.params;
    const { markdownText } = req.body;

    console.log(`[Export Router /${format}] Received request.`);

    if (!markdownText) {
        return res.status(400).json({ success: false, message: 'Markdown text is required in the request body.' });
    }

    const supportedFormats = ['docx', 'pdf'];
    if (!supportedFormats.includes(format.toLowerCase())) {
        return res.status(400).json({ success: false, message: `Unsupported export format: ${format}. Supported: ${supportedFormats.join(', ')}` });
    }

    try {
        // exportMarkdown is expected to place the file in the temp_exports directory
        // and return its absolute path.
        const outputFilePath = await exportMarkdown(markdownText, format.toLowerCase());
        const outputFileName = path.basename(outputFilePath);

        console.log(`[Export Router /${format}] File generated: ${outputFilePath}`);

        // Construct the download link.
        // /api/exports is statically served by server.mjs from the temp_exports directory.
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
        console.error(`[Export Router /${format}] Error during export:`, error.message);
        // Pass to the global error handler
        const errorForClient = new Error(`Error exporting to ${format}: ${error.message}`);
        errorForClient.statusCode = 500;
        next(errorForClient);
    }
});

export default router;