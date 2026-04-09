// netlify/functions/config.js
//
// Returns ONLY the public-safe fields of a client's config (name, colors,
// greeting, booking placeholder text). The system prompt stays server-side.

const fs = require('fs');
const path = require('path');

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

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300'
  };

  const clientId = (event.queryStringParameters || {}).clientId || '';
  if (!/^[a-z0-9-]{1,64}$/i.test(clientId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid clientId' }) };
  }

  const file = path.join(CLIENTS_DIR, `${clientId}.json`);
  if (!fs.existsSync(file)) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Unknown client' }) };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Whitelist public fields — never expose systemPrompt or allowedDomains.
    const publicConfig = {
      clientId,
      businessName: raw.businessName || '',
      assistantName: raw.assistantName || 'Assistant',
      avatarLetter: raw.avatarLetter || (raw.assistantName || 'A')[0].toUpperCase(),
      greeting: raw.greeting || `Hi! How can I help you today?`,
      placeholder: raw.placeholder || 'Type a message…',
      position: raw.position || 'bottom-right',
      theme: raw.theme || {}
    };
    return { statusCode: 200, headers, body: JSON.stringify(publicConfig) };
  } catch (e) {
    console.error('config error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Config error' }) };
  }
};
