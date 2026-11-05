import session from 'express-session';
import { PostgresSessionStore } from './postgresSessionStore.mjs';

export const OAUTH_SESSION_PATH = '/api/login/auth/google';
export const OAUTH_SESSION_TTL_SECONDS = 600;

// Import lazily so local memory sessions and injected tests do not create a pool.
const defaultDatabase = async () => (await import('../db.mjs')).default;

/** Short-lived OAuth state only. Application authentication remains JWT-based. */
export function createOAuthSession({ environment = process.env, database, logger = console, now = Date.now } = {}) {
  const production = environment.NODE_ENV === 'production';
  const secret = environment.SESSION_SECRET || environment.JWT_SECRET;
  if (!secret) throw new Error('SESSION_SECRET or JWT_SECRET is required.');
  if (production && !database && !environment.DATABASE_URL && !environment.DB_HOST) {
    throw new Error('DATABASE_URL or DB_HOST is required for production OAuth sessions.');
  }
  const store = production ? new PostgresSessionStore({
    database: database || defaultDatabase, ttlMs: OAUTH_SESSION_TTL_SECONDS * 1000, logger, now,
  }) : undefined;
  return {
    middleware: session({
      name: 'synapse.oauth.sid', secret, store,
      resave: false, saveUninitialized: false,
      cookie: { path: OAUTH_SESSION_PATH, httpOnly: true, sameSite: 'lax', secure: production,
        maxAge: OAUTH_SESSION_TTL_SECONDS * 1000 },
    }),
    async healthy() { return store ? store.healthy() : true; },
    // The shared application pool is closed by server.mjs; this store owns no handles.
    async close() {},
  };
}
