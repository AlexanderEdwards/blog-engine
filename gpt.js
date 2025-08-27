// Generates HTML for a blog post.
// If OPENAI_API_KEY is present, attempts to call OpenAI's REST API.
// Otherwise, falls back to a simple HTML formatter that is CSS-agnostic.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const { logEvent } = require('./db');

async function generateHTML({ site, title, content, images = [] }) {
  const prompt = buildPrompt({ site, title, content, images });

  // Basic context for logs without leaking secrets
  const context = {
    site: String(site || 'default'),
    title_len: String(title || '').length,
    content_len: String(content || '').length,
    images_count: Array.isArray(images) ? images.length : 0
  };

  if (OPENAI_API_KEY) {
    const t0 = Date.now();
    try {
      await safeLog('gpt_generate_start', { ...context });
      const html = await callOpenAI(prompt);
      const dt = Date.now() - t0;
      if (html && typeof html === 'string' && html.trim().length) {
        await safeLog('gpt_generate_success', {
          ...context,
          duration_ms: dt,
          response_len: html.length,
          preview: String(html).slice(0, 200)
        });
        return html.trim();
      } else {
        await safeLog('gpt_generate_empty', { ...context, duration_ms: dt, response_len: html ? String(html).length : 0 });
      }
    } catch (err) {
      const dt = Date.now() - t0;
      await safeLog('gpt_generate_error', {
        ...context,
        duration_ms: dt,
        error: err && err.message ? String(err.message).slice(0, 300) : 'unknown'
      });
      // Fall through to fallback formatter
    }
  } else {
    await safeLog('gpt_generate_fallback', { ...context, reason: 'no_api_key' });
  }
  const html = fallbackFormatter({ title, content, images });
  await safeLog('gpt_fallback_rendered', { ...context, html_len: html.length, preview: html.slice(0, 200) });
  return html;
}

function buildPrompt({ site, title, content, images }) {
  const imgList = (images || []).map((u, i) => `- Image ${i + 1}: ${u}`).join('\n');
  return `You are generating a blog post HTML fragment for the site "${site}".
Constraints:
- Output ONLY a semantic HTML fragment (no <html>, <head>, or <body> tags)
- Do NOT include <style> or inline styles; use semantic tags
- The HTML must inherit styling from the parent site CSS
- Use accessible markup (alt text for images, headings, lists, figure/figcaption)

Post metadata:
- Title: ${title}
- Site context: ${site}
- Images:\n${imgList || '- None'}

Source content:
${content}

Return only the HTML fragment.`;
}

async function callOpenAI(prompt) {
  // Minimal REST call without external deps. Node 20 has global fetch.
  const body = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You format posts into clean, semantic HTML fragments without inline styles.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.4
  };

  const t0 = Date.now();
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const dt = Date.now() - t0;
    let errText = '';
    try { errText = await resp.text(); } catch (_) {}
    await safeLog('gpt_api_error', { status: resp.status, duration_ms: dt, body_preview: String(errText).slice(0, 300) });
    throw new Error(`OpenAI API error: ${resp.status}`);
  }
  const data = await resp.json();
  const dt = Date.now() - t0;
  const choice = data?.choices?.[0]?.message?.content || '';
  await safeLog('gpt_api_success', { duration_ms: dt, response_len: choice.length, preview: String(choice).slice(0, 200) });
  return choice;
}

function fallbackFormatter({ title, content, images }) {
  const imgs = (images || []).map(u => `<figure><img src="${escapeHtml(u)}" alt="${escapeHtml(title)} image"/><figcaption></figcaption></figure>`).join('\n');
  const safeContent = escapeHtml(content).replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br/>');
  return `
<article>
  <header>
    <h1>${escapeHtml(title)}</h1>
  </header>
  ${imgs}
  <section>
    <p>${safeContent}</p>
  </section>
</article>
`.trim();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { generateHTML };

// Helper to safely write to user_logs without throwing
async function safeLog(event, details) {
  try {
    await logEvent(event, details);
  } catch (_) {
    // no-op
  }
}
