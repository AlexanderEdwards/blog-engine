const { Pool } = require('pg');

// Configure Pool. SSL required on Heroku.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const USER_ID = 'edwardsalexk_gmail_com';

// Ensure connections use the user-isolated schema. This avoids referencing public.app_data.
// We validate the schema name strictly to a safe pattern and apply via set_config using parameters.
const SCHEMA = process.env.DB_SCHEMA || 'public';
const SAFE_SCHEMA = /^[a-zA-Z0-9_]+$/.test(SCHEMA) ? SCHEMA : 'public';

pool.on('connect', async (client) => {
  try {
    // Use parameterized call to avoid injection and include public as fallback on search_path
    await client.query('SELECT set_config($1, $2, false)', ['search_path', `${SAFE_SCHEMA},public`]);
  } catch (_) {
    // If this fails, we keep going; queries may still work if default schema is correct
  }
});

async function getPool() {
  return pool;
}

async function saveKV(key, value) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO app_data (key, value, user_id) VALUES ($1, $2::jsonb, $3) ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
      [key, JSON.stringify(value), USER_ID]
    );
  } finally {
    client.release();
  }
}

async function getKV(key) {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT value FROM app_data WHERE key = $1 AND user_id = $2', [key, USER_ID]);
    if (!result.rows.length) return null;
    return result.rows[0].value;
  } finally {
    client.release();
  }
}

async function deleteKV(key) {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM app_data WHERE key = $1 AND user_id = $2', [key, USER_ID]);
  } finally {
    client.release();
  }
}

async function listKeysByPrefix(prefix) {
  const client = await pool.connect();
  try {
    // Safe parameter for LIKE prefix search
    const pattern = prefix + '%';
    const result = await client.query('SELECT key FROM app_data WHERE key LIKE $1 AND user_id = $2 ORDER BY key DESC', [pattern, USER_ID]);
    return result.rows.map(r => r.key);
  } finally {
    client.release();
  }
}

async function logEvent(event, details) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO user_logs (event, details, user_id) VALUES ($1, $2::jsonb, $3)',
      [event, JSON.stringify(details || {}), USER_ID]
    );
  } catch (_) {
    // Swallow logging errors silently
  } finally {
    client.release();
  }
}

module.exports = { getPool, saveKV, getKV, deleteKV, listKeysByPrefix, logEvent };
