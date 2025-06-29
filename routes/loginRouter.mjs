// backend/routes/loginRouter.mjs
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import db from '../db.mjs';

const router = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ===== PASSPORT CONFIGURATION (Find or Create User) =====

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: '/api/login/auth/google/callback', // Must match Google Console setting
    scope: ['profile', 'email']
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
router.post('/register', async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }
  try {
    const existingUser = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ message: 'User with this email already exists.' });
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const newUser = await db.query(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING user_id, email',
      [email, hashedPassword]
    );
    res.status(201).json({
      message: 'User registered successfully!',
      user: newUser.rows[0],
    });
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

    // Check if user exists and if they registered using email/password (i.e., password is not null)
    if (!user || !user.password) {
      return res.status(401).json({ message: 'Invalid credentials or user signed up with Google.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }
    
    const token = jwt.sign(
      { user_id: user.user_id, email: user.email },
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
router.get('/auth/google', passport.authenticate('google'));

// The callback route that Google redirects to after the user authorizes
router.get('/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: `${FRONTEND_URL}/login?error=google_failed`, // Redirect on failure
    session: false // We are not using server sessions for the final auth, but JWT
  }),
  (req, res) => {
    // At this point, `req.user` is populated by Passport with the user record from the DB
    // We now create our own JWT and send the user back to the frontend.
    const token = jwt.sign(
      { user_id: req.user.user_id, email: req.user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    // Redirect to a specific frontend page that will handle the token
    res.redirect(`${FRONTEND_URL}/auth/callback?token=${token}`);
  }
);


export default router;