const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5, // Ideal untuk serverless function agar tidak menghabiskan pool Supabase
});

// Schema is managed through schema.sql; runtime initialization intentionally runs no DDL.
const initializeSchema = async () => {};

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  initializeSchema,
};
