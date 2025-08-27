const express = require('express');
const path = require('path');
const { getPool, saveKV, getKV, deleteKV, listKeysByPrefix, logEvent } = require('./db');
const { generateHTML } = require('./gpt');
const { slugify } = require('./utils/slugify');
const { ensureAdminUser, verifyPassword, getOrCreateSessionSecret, createSessionToken, verifySessionToken } = require('./utils/auth');

const app = express();

// Body parsers
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Derive site key from host
function siteFromHost(hostname) {
  if (!hostname) return 'default';
  // normalize localhost patterns for local testing
  const hn = String(hostname).toLowerCase();
  if (hn.startsWith('localhost') || hn.startsWith('127.0.0.1')) return 'default';
  // convert host to folder-friendly
  return hn.replace(/[^a-z0-9.-]/g, '').replace(/\./g, '_');
}

// Serve admin assets
app.use('/public', express.static(path.join(__dirname, 'public')));

// Parse cookies minimal
function parseCookies(req) {
  const hdr = req.headers['cookie'];
  if (!hdr) return {};
  return hdr.split(';').map(v => v.trim()).reduce((acc, part) => {
    const eq = part.indexOf('=');
    if (eq === -1) return acc;
    const k = decodeURIComponent(part.slice(0, eq));
    const val = decodeURIComponent(part.slice(eq + 1));
    acc[k] = val;
    return acc;
  }, {});
}

// Simple auth middleware using signed cookie
async function requireAuth(req, res, next) {
  try {
    const cookies = parseCookies(req);
    const token = cookies['auth'];
    if (!token) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Login required' });
    const secret = await getOrCreateSessionSecret();
    const payload = verifySessionToken(token, secret);
    if (!payload || payload.sub !== 'edwardsalexk@gmail.com' || payload.exp < Date.now()) {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Invalid session' });
    }
    req.user = { email: payload.sub };
    next();
  } catch (_) {
    return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Auth error' });
  }
}

// Seed admin user credentials on boot
(async () => {
  try {
    await ensureAdminUser({ email: 'edwardsalexk@gmail.com', password: 'vixen1993' });
  } catch (err) {
    // Swallow to avoid leaking details; log minimal event
    try { await logEvent('admin_seed_error', { message: err.message }); } catch (_) {}
  }
})();

// Admin UI
app.get('/admin', async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const token = cookies['auth'];
    const secret = await getOrCreateSessionSecret();
    const payload = token ? verifySessionToken(token, secret) : null;
    const valid = payload && payload.sub === 'edwardsalexk@gmail.com' && payload.exp > Date.now();
    res.sendFile(path.join(__dirname, 'public', valid ? 'admin.html' : 'login.html'));
  } catch (_) {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

// Login endpoint
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const email = String(username || '').trim().toLowerCase();
    if (!email || !password) {
      return res.status(400).json({ ok: false, code: 'INVALID_INPUT', message: 'Username and password required' });
    }
    if (email !== 'edwardsalexk@gmail.com') {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Invalid credentials' });
    }
    const ok = await verifyPassword(email, password);
    if (!ok) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Invalid credentials' });
    const secret = await getOrCreateSessionSecret();
    const token = createSessionToken({ sub: email, ttlMs: 1000 * 60 * 60 * 24 * 7 }, secret); // 7 days
    const cookie = `auth=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`;
    res.setHeader('Set-Cookie', cookie);
    await logEvent('admin_login', { email });
    return res.json({ ok: true, message: 'Logged in' });
  } catch (err) {
    await logEvent('admin_login_error', { message: err.message });
    return res.status(500).json({ ok: false, code: 'LOGIN_FAIL', message: 'Login failed', detail: err.message });
  }
});

// Logout endpoint
app.post('/api/admin/logout', async (req, res) => {
  res.setHeader('Set-Cookie', 'auth=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  try { await logEvent('admin_logout', {}); } catch (_) {}
  res.json({ ok: true, message: 'Logged out' });
});

// Admin API - list posts
app.get('/api/admin/posts', requireAuth, async (req, res) => {
  const site = siteFromHost(req.hostname);
  try {
    const prefix = `post:${site}:`;
    const keys = await listKeysByPrefix(prefix);
    const posts = [];
    for (const key of keys) {
      const data = await getKV(key);
      if (data) {
        // Only include minimal metadata for listing
        posts.push({
          slug: data.slug,
          title: data.title,
          created_at: data.created_at,
          updated_at: data.updated_at
        });
      }
    }
    res.json({ ok: true, site, posts });
  } catch (err) {
    await logEvent('admin_list_error', { message: err.message });
    res.status(500).json({ ok: false, code: 'ADMIN_LIST_FAIL', message: 'Failed to list posts', detail: err.message });
  }
});

// Admin API - get a post
app.get('/api/admin/posts/:slug', requireAuth, async (req, res) => {
  const site = siteFromHost(req.hostname);
  const slug = String(req.params.slug || '').toLowerCase();
  try {
    const key = `post:${site}:${slug}`;
    const data = await getKV(key);
    if (!data) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Post not found' });
    res.json({ ok: true, site, post: data });
  } catch (err) {
    await logEvent('admin_get_error', { message: err.message, slug });
    res.status(500).json({ ok: false, code: 'ADMIN_GET_FAIL', message: 'Failed to get post', detail: err.message });
  }
});

// Admin API - create/update post
app.post('/api/admin/posts', requireAuth, async (req, res) => {
  const site = siteFromHost(req.hostname);
  const { title, content, images = [], slug: slugInput } = req.body || {};

  if (!title || !content) {
    return res.status(400).json({ ok: false, code: 'INVALID_INPUT', message: 'Title and content are required' });
  }

  const slug = slugify(slugInput || title);
  const key = `post:${site}:${slug}`;

  try {
    const html = await generateHTML({
      site,
      title,
      content,
      images: Array.isArray(images) ? images : String(images || '').split(',').map(s => s.trim()).filter(Boolean)
    });

    const now = new Date().toISOString();
    const existing = await getKV(key);
    const value = {
      site,
      slug,
      title,
      content,
      images: Array.isArray(images) ? images : String(images || '').split(',').map(s => s.trim()).filter(Boolean),
      html,
      created_at: existing?.created_at || now,
      updated_at: now
    };

    await saveKV(key, value);
    await logEvent('admin_post_saved', { site, slug, title });
    res.json({ ok: true, site, slug, message: 'Post saved' });
  } catch (err) {
    await logEvent('admin_save_error', { message: err.message });
    res.status(500).json({ ok: false, code: 'ADMIN_SAVE_FAIL', message: 'Failed to save post', detail: err.message });
  }
});

// Admin API - delete post
app.delete('/api/admin/posts/:slug', requireAuth, async (req, res) => {
  const site = siteFromHost(req.hostname);
  const slug = String(req.params.slug || '').toLowerCase();
  const key = `post:${site}:${slug}`;
  try {
    await deleteKV(key);
    await logEvent('admin_post_deleted', { site, slug });
    res.json({ ok: true, site, slug, message: 'Post deleted' });
  } catch (err) {
    await logEvent('admin_delete_error', { message: err.message, slug });
    res.status(500).json({ ok: false, code: 'ADMIN_DELETE_FAIL', message: 'Failed to delete post', detail: err.message });
  }
});

// Render post page (inherits site CSS)
app.get(['/posts/:slug', '/p/:slug'], async (req, res) => {
  const site = siteFromHost(req.hostname);
  const slug = String(req.params.slug || '').toLowerCase();
  const key = `post:${site}:${slug}`;
  try {
    const data = await getKV(key);
    if (!data) return res.status(404).send('Post not found');

    const siteDir = path.join(__dirname, 'sites', site);
    const styleHref = '/site-style.css';
    const bodyHtml = data.html || `<article><h1>${data.title}</h1><div>${data.content}</div></article>`;

    const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(data.title)} – ${escapeHtml(site)}</title>
  <link rel="stylesheet" href="${styleHref}">
  <style>main{max-width:800px;margin:2rem auto;padding:0 1rem}</style>
  </head>
  <body>
    <main>
      ${bodyHtml}
    </main>
  </body>
  </html>`;

    res.send(page);
  } catch (err) {
    await logEvent('render_post_error', { message: err.message, slug });
    res.status(500).send('Failed to render post');
  }
});

// Serve site-specific index and assets
app.get('/site-style.css', (req, res) => {
  const site = siteFromHost(req.hostname);
  const stylePath = path.join(__dirname, 'sites', site, 'style.css');
  res.sendFile(stylePath, (err) => {
    if (err) res.status(404).type('text/css').send('');
  });
});

app.get('/', (req, res) => {
  const site = siteFromHost(req.hostname);
  const indexPath = path.join(__dirname, 'sites', site, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(200).send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Welcome</title><link rel="stylesheet" href="/site-style.css"></head><body><main style="max-width:700px;margin:2rem auto;padding:1rem"><h1>Welcome</h1><p>No index.html for site <code>${escapeHtml(site)}</code>. Create one at <code>sites/${escapeHtml(site)}/index.html</code>.</p><p><a href="/admin">Open CMS</a></p></main></body></html>`);
    }
  });
});

// Minimal XSS-safe escape for titles
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  // Do not log env; keep minimal message
  console.log(`blog-engine listening on :${port}`);
});

module.exports = app;
