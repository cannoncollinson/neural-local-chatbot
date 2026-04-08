// netlify/functions/chat.js
//
// Multi-tenant chat endpoint. The client site sends { clientId, messages },
// and this function looks up that client's system prompt + settings on the
// server. The prompt is NEVER sent from the browser, so clients can't be
// tampered with and the API key can't be abused by unknown domains.

const fs = require('fs');
const path = require('path');

// --- Resolve the clients/ directory ---
// On Netlify, included_files are bundled into the function and live at
// LAMBDA_TASK_ROOT. Locally, they live two directories up from __dirname.
// We try a few candidate paths so this works in every environment.
function resolveClientsDir() {
  const candidates = [
    process.env.LAMBDA_TASK_ROOT && path.join(process.env.LAMBDA_TASK_ROOT, 'clients'),
    path.join(process.cwd(), 'clients'),
    path.join(__dirname, '..', '..', 'clients'),
    path.join(__dirname, 'clients')
  ].filter(Boolean);
  for (const dir of candidates) {
    try { if (fs.existsSync(dir)) return dir; } catch (_) {}
  }
  return candidates[0];
}
const CLIENTS_DIR = resolveClientsDir();

function loadClient(clientId) {
  // Basic sanitization — clientId must be alphanumeric + dashes only.
  if (!/^[a-z0-9-]{1,64}$/i.test(clientId)) return null;
  const file = path.join(CLIENTS_DIR, `${clientId}.json`);
  if (!fs.existsSync(file)) {
    console.error(`Client file not found: ${file}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Failed to parse client config ${clientId}:`, e);
    return null;
  }
}

// --- CORS helpers ---
function corsHeaders(origin, allowedDomains) {
  // If the client has an allowedDomains list, only echo back the origin
  // if it matches. Otherwise allow all (useful during onboarding/testing).
  let allowOrigin = '*';
  if (allowedDomains && allowedDomains.length > 0 && origin) {
    try {
      const host = new URL(origin).hostname;
      const ok = allowedDomains.some(d =>
        host === d || host.endsWith(`.${d}`)
      );
      allowOrigin = ok ? origin : 'null';
    } catch {
      allowOrigin = 'null';
    }
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

exports.handler = async function(event) {
  const origin = event.headers.origin || event.headers.Origin || '';

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin, null), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders(origin, null),
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders(origin, null),
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  const { clientId, messages } = payload;

  if (!clientId || !Array.isArray(messages)) {
    return {
      statusCode: 400,
      headers: corsHeaders(origin, null),
      body: JSON.stringify({ error: 'Missing clientId or messages' })
    };
  }

  const client = loadClient(clientId);
  if (!client) {
    return {
      statusCode: 404,
      headers: corsHeaders(origin, null),
      body: JSON.stringify({ error: 'Unknown client' })
    };
  }

  // Enforce allowed domains (if the client config specifies them).
  const headers = corsHeaders(origin, client.allowedDomains);
  if (client.allowedDomains && client.allowedDomains.length > 0) {
    if (headers['Access-Control-Allow-Origin'] === 'null') {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Origin not allowed for this client' })
      };
    }
  }

  // Cap conversation length to keep costs predictable.
  const trimmed = messages.slice(-20).filter(m =>
    m && typeof m.role === 'string' && typeof m.content === 'string'
  );

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: client.model || 'claude-haiku-4-5-20251001',
        max_tokens: client.maxTokens || 300,
        system: client.systemPrompt,
        messages: trimmed
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ reply: "Sorry, I'm having trouble connecting right now." })
      };
    }

    const reply = data.content?.[0]?.text || "Sorry, something went wrong.";
    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
  } catch (e) {
    console.error('chat function error:', e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ reply: "Sorry, I'm having trouble connecting right now." })
    };
  }
};
