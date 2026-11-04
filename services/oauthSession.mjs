import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';

export const OAUTH_SESSION_PATH = '/api/login/auth/google';
export const OAUTH_SESSION_TTL_SECONDS = 600;

/** Short-lived OAuth state only. Application authentication remains JWT-based. */
export function createOAuthSession({ environment = process.env, redisClient, logger = console } = {}) {
  const production = environment.NODE_ENV === 'production';
  const secret = environment.SESSION_SECRET || environment.JWT_SECRET;
  if (!secret) throw new Error('SESSION_SECRET or JWT_SECRET is required.');
  if (production && !environment.REDIS_URL && !redisClient) throw new Error('REDIS_URL is required for production OAuth sessions.');
  const client = production ? redisClient || createClient({
    url: environment.REDIS_URL,
    disableOfflineQueue: true,
    socket: { connectTimeout: 3000, reconnectStrategy: retries => Math.min(250 * (retries + 1), 3000) },
  }) : null;
  if (client) {
    client.on('error', error => logger.error(JSON.stringify({ event: 'oauth_session_store_error', code: error.code || 'REDIS_UNAVAILABLE' })));
    if (!client.isOpen) void client.connect().catch(() => {});
  }
  const store = client ? new RedisStore({ client, prefix: 'synapse:oauth:', ttl: OAUTH_SESSION_TTL_SECONDS }) : undefined;
  return {
    middleware: session({
      name: 'synapse.oauth.sid', secret, store,
      resave: false, saveUninitialized: false,
      cookie: { path: OAUTH_SESSION_PATH, httpOnly: true, sameSite: 'lax', secure: production,
        maxAge: OAUTH_SESSION_TTL_SECONDS * 1000 },
    }),
    async healthy() { return !client || (client.isReady && await client.ping() === 'PONG'); },
    async close() { if (client?.isOpen) client.destroy(); },
  };
}
