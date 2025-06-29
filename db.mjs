// backend/db.mjs
import pg from 'pg';

const { Pool } = pg;

// Define the connection configuration object
let dbConfig;

// Check if the DATABASE_URL environment variable is available (it will be on Render)
if (process.env.DATABASE_URL) {
  // Production/Cloud environment
  dbConfig = {
    connectionString: process.env.DATABASE_URL,
    // It's a good practice to require SSL in production
    ssl: {
      rejectUnauthorized: false
    }
  };
  console.log('[DB] Connecting to database using DATABASE_URL.');
} else {
  // Local development environment
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
  // This event fires on successful connection
  // You can remove the log if it gets too noisy
});

export default {
  query: (text, params) => pool.query(text, params),
};