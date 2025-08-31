// backend/middleware/webhookAuth.mjs
import 'dotenv/config'; // Ensure environment variables are loaded

export const verifyWebhookSecret = (req, res, next) => {
    // The secret token is expected in the 'X-Webhook-Secret' header
    const secret = req.headers['x-webhook-secret'];
    const expectedSecret = process.env.WEBHOOK_SECRET_TOKEN; // Get this from your .env file or Render env vars

    if (!expectedSecret) {
        console.error('[Webhook Auth] WEBHOOK_SECRET_TOKEN is not set in environment variables!');
        return res.status(500).json({ success: false, message: 'Server configuration error: Webhook secret not set.' });
    }

    if (!secret || secret !== expectedSecret) {
        console.warn(`[Webhook Auth] Unauthorized webhook access attempt from IP: ${req.ip}`);
        return res.status(403).json({ success: false, message: 'Unauthorized access: Invalid webhook secret.' });
    }
    next(); // If secret is valid, proceed to the next middleware/route handler
};