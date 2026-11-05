import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { sendConfirmationEmail, assertEmailConfigured } from './emailService.mjs';

function registrationError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code, expose: true });
}

/** Keep pending accounts intact; the same password can retry a failed confirmation delivery. */
export function createRegistrationService({ database,
  emailService = { sendConfirmationEmail, assertConfigured: assertEmailConfigured },
  hashPassword = password => bcrypt.hash(password, 10), comparePassword = bcrypt.compare,
  newToken = () => randomBytes(32).toString('hex'), now = Date.now,
} = {}) {
  if (!database) throw new Error('A database is required for registration.');

  async function register(input) {
    const { email, password } = input ?? {};
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(email) ||
      typeof password !== 'string' || password.length < 8 || password.length > 128) {
      throw registrationError('Enter a valid email address and a password with 8 to 128 characters.', 400, 'INVALID_REGISTRATION');
    }
    // Missing provider credentials must not leave a new pending account behind.
    emailService.assertConfigured();
    const result = await database.query(`SELECT user_id, email, password, google_id, is_email_confirmed,
      email_confirmation_token, email_confirmation_expires FROM users WHERE email = $1`, [email]);
    const existing = result.rows[0];
    let token;
    let created = false;
    if (existing) {
      // Google accounts can have is_email_confirmed=false; never delete or replace their data.
      if (existing.is_email_confirmed || existing.google_id || !existing.password) {
        throw registrationError('An account with this email already exists. Please sign in.', 409, 'ACCOUNT_EXISTS');
      }
      if (!await comparePassword(password, existing.password)) {
        throw registrationError('This email is pending confirmation. Retry with the password you originally chose.', 409, 'REGISTRATION_PENDING');
      }
      token = existing.email_confirmation_token;
      if (!token || Date.parse(existing.email_confirmation_expires) <= now() ||
        !Number.isFinite(Date.parse(existing.email_confirmation_expires))) {
        token = newToken();
        const updated = await database.query(`UPDATE users SET email_confirmation_token = $1, email_confirmation_expires = $2
          WHERE user_id = $3 AND is_email_confirmed IS NOT TRUE AND google_id IS NULL AND password = $4 RETURNING user_id`,
        [token, new Date(now() + 3_600_000), existing.user_id, existing.password]);
        if (!updated.rows.length) throw registrationError('This account changed during registration. Please sign in or try again.', 409, 'REGISTRATION_CHANGED');
      }
    } else {
      token = newToken();
      const hashedPassword = await hashPassword(password);
      try {
        await database.query(`INSERT INTO users (email, password, email_confirmation_token, email_confirmation_expires)
          VALUES ($1, $2, $3, $4)`, [email, hashedPassword, token, new Date(now() + 3_600_000)]);
        created = true;
      } catch (error) {
        if (error.code === '23505') throw registrationError('An account with this email already exists. Please sign in or retry registration.', 409, 'ACCOUNT_EXISTS');
        throw error;
      }
    }
    try {
      // Reuse an unexpired token. Resend deduplicates repeated sends using its hashed idempotency key.
      await emailService.sendConfirmationEmail(email, token);
    } catch {
      // Do not invalidate a token: a timeout may occur after the provider delivered the email.
      throw registrationError('Your account is saved, but the confirmation email could not be sent. Please retry registration with the same email and password.',
        503, 'CONFIRMATION_DELIVERY_FAILED');
    }
    return { status: created ? 201 : 200,
      message: 'Please check your email to activate your account. You can retry registration with the same password if the email does not arrive.' };
  }

  return { register };
}
