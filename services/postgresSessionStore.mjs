import session from 'express-session';

/** A short-lived, shared OAuth state store. No timer or dedicated database connection. */
export class PostgresSessionStore extends session.Store {
  constructor({ database, ttlMs = 600_000, now = Date.now, logger = console } = {}) {
    super();
    if (!database) throw new Error('A database is required for OAuth sessions.');
    this.database = database;
    this.ttlMs = ttlMs;
    this.now = now;
    this.logger = logger;
    this.nextPruneAt = 0;
    this.pruning = null;
  }

  async query(text, values) {
    const database = typeof this.database === 'function' ? await this.database() : this.database;
    return database.query(text, values);
  }

  expiresAt(sess) {
    const limit = this.now() + this.ttlMs;
    const cookieExpiry = Date.parse(sess?.cookie?.expires);
    return new Date(Number.isFinite(cookieExpiry) ? Math.min(cookieExpiry, limit) : limit);
  }

  run(operation, callback = () => {}) {
    Promise.resolve().then(operation).then(
      value => callback(null, value),
      () => {
        this.logger.error?.(JSON.stringify({ event: 'oauth_session_store_error', code: 'OAUTH_SESSION_UNAVAILABLE' }));
        const error = new Error('Google sign-in is temporarily unavailable. Please try again.');
        error.code = 'OAUTH_SESSION_UNAVAILABLE';
        error.statusCode = 503;
        error.expose = true;
        callback(error);
      },
    );
  }

  get(sid, callback) {
    this.run(async () => {
      const result = await this.query(
        'SELECT sess FROM oauth_sessions WHERE sid = $1 AND expires_at > $2', [sid, new Date(this.now())],
      );
      return result.rows[0]?.sess ?? null;
    }, callback);
  }

  set(sid, sess, callback) {
    this.run(async () => {
      await this.query(`INSERT INTO oauth_sessions (sid, sess, expires_at) VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expires_at = EXCLUDED.expires_at`,
      [sid, JSON.stringify(sess), this.expiresAt(sess)]);
      await this.prune();
    }, callback);
  }

  destroy(sid, callback) {
    this.run(async () => {
      await this.query('DELETE FROM oauth_sessions WHERE sid = $1', [sid]);
      await this.prune();
    }, callback);
  }

  touch(sid, sess, callback) {
    this.run(async () => {
      // An expired session must never be revived by a late response.
      await this.query('UPDATE oauth_sessions SET expires_at = $2 WHERE sid = $1 AND expires_at > $3',
        [sid, this.expiresAt(sess), new Date(this.now())]);
      await this.prune();
    }, callback);
  }

  async prune() {
    if (this.pruning) return this.pruning;
    if (this.now() < this.nextPruneAt) return;
    this.nextPruneAt = this.now() + 60_000;
    this.pruning = this.query('DELETE FROM oauth_sessions WHERE expires_at <= $1', [new Date(this.now())])
      .catch(() => this.logger.error?.(JSON.stringify({ event: 'oauth_session_cleanup_error', code: 'OAUTH_CLEANUP_UNAVAILABLE' })))
      .finally(() => { this.pruning = null; });
    return this.pruning;
  }

  async healthy() {
    try {
      await this.query('SELECT 1 FROM oauth_sessions LIMIT 1');
      return true;
    } catch {
      return false;
    }
  }
}
