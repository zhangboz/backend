import express from 'express';
import db from '../db.mjs';
import { subscriptionResolver } from '../services/subscriptionState.mjs';

export function createUserStatusRouter({ database = db, resolver = subscriptionResolver } = {}) {
const router = express.Router();

// MODIFICATION: This route is now at /status, mounted under /api/user in server.mjs
router.get('/status', async (req, res, next) => {
  // language is available on req.user because passport's deserializeUser does `SELECT *`
  const { user_id, email, language } = req.user;

  try {
    const { state } = await resolver.resolve(req.user);

    const userObject = {
      id: user_id,
      email: email,
      language: language || 'en', // Add language from the user record
      ...state,
    };


    res.set('Cache-Control', 'private, no-store');
    res.json({ user: userObject });

  } catch (error) {
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
        await database.query(
            'UPDATE users SET language = $1 WHERE user_id = $2',
            [language, user_id]
        );
        res.status(200).json({ success: true, message: 'Language preference updated.' });
    } catch (error) {
        next(error);
    }
});


return router;
}
export default createUserStatusRouter();
