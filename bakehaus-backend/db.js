const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5, // Ideal untuk serverless function agar tidak menghabiskan pool Supabase
});

let menuDiscountSchemaReady;
const ensureMenuDiscountColumn = () => {
  if (!menuDiscountSchemaReady) {
    menuDiscountSchemaReady = pool.query(
      'ALTER TABLE menu ADD COLUMN IF NOT EXISTS diskon_persen INT NOT NULL DEFAULT 0 CHECK (diskon_persen BETWEEN 0 AND 100)'
    ).catch((err) => {
      menuDiscountSchemaReady = null;
      throw err;
    });
  }
  return menuDiscountSchemaReady;
};

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  ensureMenuDiscountColumn,
};