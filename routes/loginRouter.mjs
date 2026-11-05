// backend/routes/loginRouter.mjs
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import db from '../db.mjs';
import { createRegistrationService } from '../services/registrationService.mjs';

const router = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
// ===== PASSPORT CONFIGURATION (Find or Create User) =====

const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
if (googleConfigured) passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/login/auth/google/callback`, // Must match Google Console setting
    scope: ['profile', 'email'],
    state: true // Bind the OAuth callback to this browser's short-lived session.
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      // 1. Check if user exists with this Google ID
      const existingUserResult = await db.query('SELECT * FROM users WHERE google_id = $1', [profile.id]);

      if (existingUserResult.rows.length > 0) {
        // User exists, pass them to the serializer
        return done(null, existingUserResult.rows[0]);
      }

      // 2. If no Google ID, check if a user exists with that email
      // This links accounts if a user registered with email/pass first, then uses Google
      const existingEmailResult = await db.query('SELECT * FROM users WHERE email = $1', [profile.emails[0].value]);

      if (existingEmailResult.rows.length > 0) {
        // User exists with this email, so we'll link their Google ID
        const userToUpdate = existingEmailResult.rows[0];
        const updatedUserResult = await db.query(
          'UPDATE users SET google_id = $1 WHERE user_id = $2 RETURNING *',
          [profile.id, userToUpdate.user_id]
        );
        return done(null, updatedUserResult.rows[0]);
      }

      // 3. If no user found, create a new one
      const newUserResult = await db.query(
        'INSERT INTO users (email, google_id, nickname) VALUES ($1, $2, $3) RETURNING *',
        [profile.emails[0].value, profile.id, profile.displayName]
      );
      return done(null, newUserResult.rows[0]);

    } catch (error) {
      return done(error, null);
    }
  }
));

// Passport session serialization
passport.serializeUser((user, done) => {
  done(null, user.user_id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const result = await db.query('SELECT * FROM users WHERE user_id = $1', [id]);
        done(null, result.rows[0]);
    } catch (error) {
        done(error, null);
    }
});


// ===== ROUTES =====
// --- 1. User Registration (Email/Password) ---
const registration = createRegistrationService({ database: db });
router.post('/register', async (req, res, next) => {
  try {
    const result = await registration.register(req.body);
    res.status(result.status).json({ message: result.message });
  } catch (error) {
    next(error);
  }
});


// --- NEW: Email Confirmation Route ---
router.get('/confirm-email/:token', async (req, res, next) => {
    try {
        const { token } = req.params;
        
        // Find user by token and check if it's not expired
        const result = await db.query(
            'SELECT * FROM users WHERE email_confirmation_token = $1 AND email_confirmation_expires > NOW()',
            [token]
        );
        
        const user = result.rows[0];
        if (!user) {
            // Redirect to a frontend page that can show an "invalid/expired token" error
            return res.redirect(`${FRONTEND_URL}/login?error=invalid_token`);
        }

        // Token is valid! Update the user.
        await db.query(
            `UPDATE users 
             SET is_email_confirmed = TRUE, email_confirmation_token = NULL, email_confirmation_expires = NULL 
             WHERE user_id = $1`,
            [user.user_id]
        );

        // Redirect to login page with a success message
        res.redirect(`${FRONTEND_URL}/login?confirmed=true`);

    } catch (error) {
        next(error);
    }
});


// --- 2. User Login (Email/Password) ---
router.post('/login', async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }
  try {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user || !user.password) {
      return res.status(401).json({ message: 'Invalid credentials or user signed up with Google.' });
    }

    // --- ADDED: CHECK IF EMAIL IS CONFIRMED ---
    if (!user.is_email_confirmed) {
        return res.status(403).json({ message: 'Please confirm your email before logging in.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }
    
    const token = jwt.sign(
      { user_id: user.user_id, email: user.email, language: user.language },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ message: 'Logged in successfully!', token });
  } catch (error) {
    next(error);
  }
});


// --- 3. Google OAuth Routes ---

// The route that initiates the Google authentication flow
const requireGoogle = (_req, res, next) => googleConfigured ? next() : res.status(503).json({ message: 'Google login is not configured. Please use email login.' });
router.get('/auth/google', requireGoogle, passport.authenticate('google', { session: false }));

// The callback route that Google redirects to after the user authorizes
router.get('/auth/google/callback', requireGoogle,
  passport.authenticate('google', {
    failureRedirect: `${FRONTEND_URL}/login?error=google_failed`, // Redirect on failure
    session: false // We are not using server sessions for the final auth, but JWT
  }),
  (req, res) => {
    // At this point, `req.user` is populated by Passport with the user record from the DB
    // We now create our own JWT and send the user back to the frontend.
    // MODIFICATION: Add language to the JWT payload
    const token = jwt.sign(
      { user_id: req.user.user_id, email: req.user.email, language: req.user.language },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    // Redirect to a specific frontend page that will handle the token
    res.redirect(`${FRONTEND_URL}/auth/callback?token=${token}`);
  }
);


export default router;