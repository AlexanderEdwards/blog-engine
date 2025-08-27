// Generates HTML for a blog post.
// If OPENAI_API_KEY is present, attempts to call OpenAI's REST API.
// Otherwise, falls back to a simple HTML formatter that is CSS-agnostic.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function generateHTML({ site, title, content, images = [] }) {
  const prompt = buildPrompt({ site, title, content, images });

  if (OPENAI_API_KEY) {
    try {
      const html = await callOpenAI(prompt);
      if (html && typeof html === 'string' && html.trim().length) return html.trim();
    } catch (_) {
      // Fall through to fallback formatter
    }
  }
  return fallbackFormatter({ title, content, images });
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

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    throw new Error(`OpenAI API error: ${resp.status}`);
  }
  const data = await resp.json();
  const choice = data?.choices?.[0]?.message?.content || '';
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

