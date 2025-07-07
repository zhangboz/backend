// backend/routes/exportRouter.mjs (SIMPLIFIED)
import express from 'express';
// Note the path change for queue
import { exportQueue } from '../FileProcessor/queue.mjs'; 
import { Job } from 'bullmq';

const router = express.Router();

// This route still ADDS a job to the queue
router.post('/:format', async (req, res, next) => {
    const { format } = req.params;
    const { markdownText } = req.body;

    console.log(`[Export Router /${format}] Received request to queue a job.`);

    if (!markdownText) {
        return res.status(400).json({ success: false, message: 'Markdown text is required.' });
    }

    const supportedFormats = ['docx', 'pdf'];
    if (!supportedFormats.includes(format.toLowerCase())) {
        return res.status(400).json({ success: false, message: `Unsupported format: ${format}.` });
    }

    try {
        // The `host` is no longer needed by the worker
        const job = await exportQueue.add('convert-file', {
            markdownText,
            targetFormat: format.toLowerCase(),
        });

        console.log(`[Export Router /${format}] Job ${job.id} queued successfully.`);

        res.status(202).json({
            success: true,
            message: `Your document conversion has been queued.`,
            jobId: job.id
        });

    } catch (error) {
        console.error(`[Export Router /${format}] Error queueing job:`, error.message);
        next(new Error(`Could not queue the export job.`));
    }
});

// The status route remains the same
router.get('/status/:jobId', async (req, res, next) => {
    try {
        const { jobId } = req.params;
        const job = await exportQueue.getJob(jobId);

        if (!job) {
            return res.status(404).json({ success: false, message: 'Job not found.' });
        }

        const state = await job.getState();
        const returnValue = job.returnvalue; // This will contain { downloadUrl, fileName } on completion

        res.json({
            success: true,
            jobId,
            state,
            result: returnValue 
        });

    } catch (error) {
        console.error(`[Export Router /status] Error fetching job status:`, error.message);
        next(new Error('Could not fetch job status.'));
    }
});

// !!! THIS ROUTE IS NO LONGER NEEDED AND CAN BE DELETED !!!
// router.get('/:fileName', ...);

export default router;