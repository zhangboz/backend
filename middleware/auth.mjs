// backend/middleware/auth.mjs
import jwt from 'jsonwebtoken';
import db from '../db.mjs';
export const requireAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <TOKEN>

  if (token == null) {
    console.log('[Auth] No token provided, rejecting request.');
    return res.status(401).json({ message: 'Unauthorized: No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
        // Make sure the essential data is in the token
    if (!decoded.user_id || !decoded.email) {
      console.log('[Auth] Token is missing user_id or email, rejecting.');
      return res.status(401).json({ message: 'Unauthorized: Malformed token' });
    }
    
    req.user = decoded; // Attach decoded user info to the request object
    next(); // Proceed to the next middleware/route handler

  } catch (err) {
    // --- ADDED LOGGING ---
    console.error('[Auth] Token verification failed:', err.message);
    return res.status(401).json({ message: `Unauthorized: ${err.message}` });
  }
};

export const requireSubscription = async (req, res, next) => {
  // This middleware MUST run AFTER requireAuth
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const subResult = await db.query(
      "SELECT subscription_status FROM subscriptions WHERE user_id = $1 AND subscription_status IN ('active', 'trialing') AND current_period_end > NOW()",
      [req.user.user_id]
    );

    if (subResult.rows.length === 0) {
      // User has no active subscription
      return res.status(403).json({ message: 'An active subscription or trial is required for this feature.' });
    }

    // User is authenticated and has an active subscription, proceed.
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAdmin = (req, res, next) => {
    // This middleware should run AFTER requireAuth, so req.user will be populated.
    if (!req.user) {
        return res.status(401).json({ message: 'Authentication required.' });
    }

    const ADMIN_USER_ID = 4;

    if (req.user.user_id !== ADMIN_USER_ID) {
        return res.status(403).json({ message: 'Forbidden: Admin access required.' });
    }

    console.log('[requireAdmin] Access granted.');
    next();
};
