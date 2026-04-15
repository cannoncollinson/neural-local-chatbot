// netlify/functions/save-lead.js
//
// When the chatbot captures a lead (name + email/phone), the embed widget
// POSTs the conversation here. This function:
//   1. Validates the client and origin
//   2. Uses Claude to extract structured fields matching the chat_logs sheet
//   3. Sends the structured data to the client's Make.com webhook
//
// Required env vars:
//   ANTHROPIC_API_KEY — already set for chat.js

const fs = require('fs');
const path = require('path');

// ── Client config loading (shared pattern with chat.js) ──────────────
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
  if (!/^[a-z0-9-]{1,64}$/i.test(clientId)) return null;
  const file = path.join(CLIENTS_DIR, `${clientId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Failed to parse client config ${clientId}:`, e);
    return null;
  }
}

// ── CORS (same pattern as chat.js) ───────────────────────────────────
function corsHeaders(origin, allowedDomains) {
  let allowOrigin = '*';
  if (allowedDomains && allowedDomains.length > 0 && origin) {
    try {
      const host = new URL(origin).hostname;
      const ok = allowedDomains.some(d => host === d || host.endsWith(`.${d}`));
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

// ── Extract chat log fields from conversation using Claude ───────────
async function extractChatLog(messages) {
  const conversationText = messages
    .map(m => `${m.role === 'user' ? 'CUSTOMER' : 'ASSISTANT'}: ${m.content}`)
    .join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: `Extract customer data from this chatbot conversation. Return ONLY valid JSON with these fields:
- "customer_name": customer's full name (string or null)
- "customer_phone": customer's phone number in E.164 format like +18015551234 (string or null)
- "customer_email": customer's email (string or null)
- "intent_detected": one of: booking / pricing / faq / complaint / general
- "lead_captured": one of: yes / partial / no — "yes" if name + phone or email, "partial" if only name or only contact info, "no" if neither
- "escalated": "yes" if the bot said it would have a staff member follow up, otherwise "no"

Return raw JSON only. No markdown, no backticks, no explanation.`,
      messages: [{ role: 'user', content: conversationText }]
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Claude extraction error: ${JSON.stringify(data)}`);

  const text = (data.content?.[0]?.text || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  }
}

// ── Send to Make.com webhook ─────────────────────────────────────────
async function sendToWebhook(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => 'no body');
    throw new Error(`Webhook error (${res.status}): ${text}`);
  }
  return true;
}

// ── Handler ──────────────────────────────────────────────────────────
exports.handler = async function (event) {
  const origin = event.headers.origin || event.headers.Origin || '';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin, null), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(origin, null), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: corsHeaders(origin, null), body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { clientId, messages, sessionId, startTime } = payload;
  if (!clientId || !Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, headers: corsHeaders(origin, null), body: JSON.stringify({ error: 'Missing clientId or messages' }) };
  }

  const client = loadClient(clientId);
  if (!client) {
    return { statusCode: 404, headers: corsHeaders(origin, null), body: JSON.stringify({ error: 'Unknown client' }) };
  }

  const headers = corsHeaders(origin, client.allowedDomains);
  if (client.allowedDomains && client.allowedDomains.length > 0) {
    if (headers['Access-Control-Allow-Origin'] === 'null') {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Origin not allowed' }) };
    }
  }

  // Use client-specific webhook, or fall back to global default
  const webhookUrl = client.webhookUrl || process.env.DEFAULT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error(`Client ${clientId} has no webhookUrl and no DEFAULT_WEBHOOK_URL set.`);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, warning: 'No webhook configured' }) };
  }

  try {
    // Step 1: Extract structured fields from conversation
    const extracted = await extractChatLog(messages);

    // Step 2: Build payload matching chat_logs sheet columns
    const now = new Date().toISOString();
    const chatLogPayload = {
      timestamp: startTime || now,
      session_id: sessionId || 'nl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      customer_name: extracted.customer_name || '',
      customer_phone: extracted.customer_phone || '',
      customer_email: extracted.customer_email || '',
      conversation_json: JSON.stringify(messages),
      message_count: messages.length,
      intent_detected: extracted.intent_detected || 'general',
      lead_captured: extracted.lead_captured || 'no',
      escalated: extracted.escalated || 'no',
      duration_sec: startTime ? Math.round((Date.now() - new Date(startTime).getTime()) / 1000) : null,
      // Extra: for Make.com routing if using one webhook for all clients
      clientId,
      businessName: client.businessName || ''
    };

    // Step 3: Send to Make.com webhook
    await sendToWebhook(webhookUrl, chatLogPayload);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error('save-lead error:', e);
    // Return 200 anyway — never disrupt the visitor's chat experience
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'Lead save failed (logged)' }) };
  }
};
