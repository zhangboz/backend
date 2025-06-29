import express from 'express';
import db from '../db.mjs';

const router = express.Router();

// This route is protected by `requireAuth` and has `req.user`
router.get('/', async (req, res, next) => {
  const { user_id, email } = req.user;

  try {
    // --- THE FIX: Part 1 ---
    // Ask the database for the current_period_end column.
    const result = await db.query(
      'SELECT subscription_status, cancel_at_period_end, current_period_end FROM subscriptions WHERE user_id = $1',
      [user_id]
    );

    const subscriptionData = result.rows[0];

    // --- THE FIX: Part 2 ---
    // Construct a full user object, now including currentPeriodEnd.
    const userObject = {
      id: user_id,
      email: email,
      subscriptionStatus: subscriptionData?.subscription_status || 'inactive',
      cancelAtPeriodEnd: subscriptionData?.cancel_at_period_end || false,
      currentPeriodEnd: subscriptionData?.current_period_end || null, // Add this line
    };


    res.json({ user: userObject });

  } catch (error) {
    console.error('[SERVER] /api/user/status: Error fetching user subscription status:', error);
    next(error);
  }
});

export default router;