// backend/db.mjs
import pg from 'pg';

const { Pool } = pg;

let dbConfig;

if (process.env.DATABASE_URL) {
  const connection = new URL(process.env.DATABASE_URL);
  if (process.env.DB_SSL === 'true') {
    // pg connection-string SSL flags otherwise override certificate validation.
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) connection.searchParams.delete(key);
  }
  dbConfig = {
    connectionString: connection.toString(),
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  };
  console.log('[DB] Connecting to database using DATABASE_URL.');
} else {
  dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  };
  console.log(`[DB] Connecting to local database: ${process.env.DB_NAME}`);
}

const pool = new Pool({ ...dbConfig, max: 5, idleTimeoutMillis: 10000, allowExitOnIdle: true });

pool.on('connect', () => {
  console.log('[DB] Database pool connected.');
});

pool.on('error', (err) => {
  console.error('[DB] Idle connection error:', err.code || 'connection_error');
});

export default {
  query: (text, params) => pool.query(text, params),
  // NEW: Method to get a client for transactions
  getClient: () => pool.connect(),
  end: () => pool.end(),
};