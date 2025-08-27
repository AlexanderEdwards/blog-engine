const { Pool } = require('pg');

// Configure Pool. SSL required on Heroku.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Some deployments include a per-row user identifier; others isolate by schema.
// We detect column presence at startup and adapt queries accordingly.
const USER_ID = 'edwardsalexk_gmail_com';
let HAS_APP_DATA_USER_ID = null;
let HAS_USER_LOGS_USER_ID = null;

// Ensure connections use the user-isolated schema. This avoids referencing public.app_data.
// We validate the schema name strictly to a safe pattern and apply via set_config using parameters.
const SCHEMA = process.env.DB_SCHEMA || 'public';
const SAFE_SCHEMA = /^[a-zA-Z0-9_]+$/.test(SCHEMA) ? SCHEMA : 'public';

async function detectCapabilities(client) {
  try {
    const q = `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('app_data', 'user_logs')
        AND column_name = 'user_id'
    `;
    const { rows } = await client.query(q);
    HAS_APP_DATA_USER_ID = rows.some(r => r.table_name === 'app_data');
    HAS_USER_LOGS_USER_ID = rows.some(r => r.table_name === 'user_logs');
  } catch (_) {
    // If detection fails, default to conservative false so we don't reference missing columns
    if (HAS_APP_DATA_USER_ID == null) HAS_APP_DATA_USER_ID = false;
    if (HAS_USER_LOGS_USER_ID == null) HAS_USER_LOGS_USER_ID = false;
  }
}

pool.on('connect', async (client) => {
  try {
    // Use parameterized call to avoid injection and include public as fallback on search_path
    await client.query('SELECT set_config($1, $2, false)', ['search_path', `${SAFE_SCHEMA},public`]);
  } catch (_) {
    // If this fails, we keep going; queries may still work if default schema is correct
  }
  // Detect table capabilities once per process
  if (HAS_APP_DATA_USER_ID === null || HAS_USER_LOGS_USER_ID === null) {
    await detectCapabilities(client);
  }
});

async function getPool() {
  return pool;
}

async function saveKV(key, value) {
  const client = await pool.connect();
  try {
    if (HAS_APP_DATA_USER_ID === null) {
      await detectCapabilities(client);
    }
    const payload = JSON.stringify(value);
    if (HAS_APP_DATA_USER_ID) {
      await client.query(
        'INSERT INTO app_data (key, value, user_id) VALUES ($1, $2::jsonb, $3) ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
        [key, payload, USER_ID]
      );
    } else {
      await client.query(
        'INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
        [key, payload]
      );
    }
  } finally {
    client.release();
  }
}

async function getKV(key) {
  const client = await pool.connect();
  try {
    if (HAS_APP_DATA_USER_ID === null) {
      await detectCapabilities(client);
    }
    let result;
    if (HAS_APP_DATA_USER_ID) {
      result = await client.query('SELECT value FROM app_data WHERE key = $1 AND user_id = $2', [key, USER_ID]);
    } else {
      result = await client.query('SELECT value FROM app_data WHERE key = $1', [key]);
    }
    if (!result.rows.length) return null;
    return result.rows[0].value;
  } finally {
    client.release();
  }
}

async function deleteKV(key) {
  const client = await pool.connect();
  try {
    if (HAS_APP_DATA_USER_ID === null) {
      await detectCapabilities(client);
    }
    if (HAS_APP_DATA_USER_ID) {
      await client.query('DELETE FROM app_data WHERE key = $1 AND user_id = $2', [key, USER_ID]);
    } else {
      await client.query('DELETE FROM app_data WHERE key = $1', [key]);
    }
  } finally {
    client.release();
  }
}

async function listKeysByPrefix(prefix) {
  const client = await pool.connect();
  try {
    if (HAS_APP_DATA_USER_ID === null) {
      await detectCapabilities(client);
    }
    // Safe parameter for LIKE prefix search
    const pattern = prefix + '%';
    let result;
    if (HAS_APP_DATA_USER_ID) {
      result = await client.query('SELECT key FROM app_data WHERE key LIKE $1 AND user_id = $2 ORDER BY key DESC', [pattern, USER_ID]);
    } else {
      result = await client.query('SELECT key FROM app_data WHERE key LIKE $1 ORDER BY key DESC', [pattern]);
    }
    return result.rows.map(r => r.key);
  } finally {
    client.release();
  }
}

async function logEvent(event, details) {
  const client = await pool.connect();
  try {
    if (HAS_USER_LOGS_USER_ID === null) {
      await detectCapabilities(client);
    }
    const payload = JSON.stringify(details || {});
    if (HAS_USER_LOGS_USER_ID) {
      await client.query(
        'INSERT INTO user_logs (event, details, user_id) VALUES ($1, $2::jsonb, $3)',
        [event, payload, USER_ID]
      );
    } else {
      await client.query(
        'INSERT INTO user_logs (event, details) VALUES ($1, $2::jsonb)',
        [event, payload]
      );
    }
  } catch (_) {
    // Swallow logging errors silently
  } finally {
    client.release();
  }
}

module.exports = { getPool, saveKV, getKV, deleteKV, listKeysByPrefix, logEvent };
