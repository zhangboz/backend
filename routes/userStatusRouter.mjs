import express from 'express';
import db from '../db.mjs';

const router = express.Router();

// MODIFICATION: This route is now at /status, mounted under /api/user in server.mjs
router.get('/status', async (req, res, next) => {
  // language is available on req.user because passport's deserializeUser does `SELECT *`
  const { user_id, email, language } = req.user;

  try {
    const result = await db.query(
      'SELECT subscription_status, cancel_at_period_end, current_period_end FROM subscriptions WHERE user_id = $1',
      [user_id]
    );

    const subscriptionData = result.rows[0];

    const userObject = {
      id: user_id,
      email: email,
      language: language || 'en', // Add language from the user record
      subscriptionStatus: subscriptionData?.subscription_status || 'inactive',
      cancelAtPeriodEnd: subscriptionData?.cancel_at_period_end || false,
      currentPeriodEnd: subscriptionData?.current_period_end || null,
    };


    res.json({ user: userObject });

  } catch (error) {
    console.error('[SERVER] /api/user/status: Error fetching user subscription status:', error);
    next(error);
  }
});

// NEW FEATURE: A new route to update the user's language preference.
// It will be available at PATCH /api/user/language
router.patch('/language', async (req, res, next) => {
    const { user_id } = req.user;
    const { language } = req.body;

    if (!language || !['en', 'zh'].includes(language)) {
        return res.status(400).json({ success: false, message: 'Invalid language specified. Must be "en" or "zh".' });
    }

    try {
        await db.query(
            'UPDATE users SET language = $1 WHERE user_id = $2',
            [language, user_id]
        );
        res.status(200).json({ success: true, message: 'Language preference updated.' });
    } catch (error) {
        console.error(`[SERVER] /api/user/language: Error updating language for user ${user_id}:`, error);
        next(error);
    }
});


export default router;