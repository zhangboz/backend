// backend/db.mjs
import pg from 'pg';

const { Pool } = pg;

let dbConfig;

if (process.env.DATABASE_URL) {
  dbConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  };
  console.log('[DB] Connecting to database using DATABASE_URL.');
} else {
  dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
  };
  console.log(`[DB] Connecting to local database: ${process.env.DB_NAME}`);
}

const pool = new Pool(dbConfig);

pool.on('connect', () => {
  console.log('[DB] Database pool connected.');
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client', err);
  process.exit(-1); // Exit process if a fatal database error occurs
});

export default {
  query: (text, params) => pool.query(text, params),
  // NEW: Method to get a client for transactions
  getClient: () => pool.connect(),
};