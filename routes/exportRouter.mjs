// backend/routes/exportRouter.mjs (MODIFIED)
import express from 'express';
import { exportQueue } from '../FileProcessor/queue.mjs'; // <-- Import the queue
import { Job } from 'bullmq'; // <-- Import Job to get job statuses

const router = express.Router();

// MODIFIED: This route now ADDS a job to the queue
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
        // The host is needed by the worker to construct the correct download URL
        const host = `${req.protocol}://${req.get('host')}`;

        // Add a job to the queue
        const job = await exportQueue.add('convert-file', {
            markdownText,
            targetFormat: format.toLowerCase(),
            host // Pass the host to the worker
        });

        console.log(`[Export Router /${format}] Job ${job.id} queued successfully.`);

        // Respond to the user immediately with the Job ID.
        // The frontend will use this ID to check the status.
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

// NEW: A route for the frontend to check the job's status
router.get('/status/:jobId', async (req, res, next) => {
    try {
        const { jobId } = req.params;
        const job = await exportQueue.getJob(jobId);

        if (!job) {
            return res.status(404).json({ success: false, message: 'Job not found.' });
        }

        const state = await job.getState();
        const returnValue = job.returnvalue; // The result from the worker

        res.json({
            success: true,
            jobId,
            state, // e.g., 'completed', 'waiting', 'active', 'failed'
            result: returnValue // This will contain { downloadUrl, fileName } on completion
        });

    } catch (error) {
        console.error(`[Export Router /status] Error fetching job status:`, error.message);
        next(new Error('Could not fetch job status.'));
    }
});


export default router;