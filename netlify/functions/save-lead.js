// netlify/functions/save-lead.js
//
// When the chatbot captures a lead, the embed widget POSTs the conversation
// here. This function:
//   1. Validates the client and origin
//   2. Uses Claude to extract structured fields matching the activity_log sheet
//   3. Sends the structured data to the client's Make.com webhook
//
// The payload maps directly to the activity_log columns in Data_V3.
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

// ── Extract all applicable fields from conversation using Claude ─────
async function extractFromConversation(messages) {
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
      max_tokens: 600,
      system: `You are a data extraction assistant. Extract customer data from this chatbot conversation. Return ONLY valid JSON with these fields:

- "recipient_name": customer's full name (string or null)
- "recipient_phone": customer's phone number in E.164 format like +18015551234. If they give a number like 4356311199 assume US +1 prefix. (string or null)
- "recipient_email": customer's email address (string or null)
- "intent": one of: booking / pricing / faq / complaint / general
- "service": which specific service they asked about, e.g. "Mow/Trim/Edge", "Aeration", "Fertilizer", "Thatching", "Landscaping", "Mulching/Bed work" — use the closest match (string or null)
- "summary": 2-3 sentence summary of the conversation — what the customer wanted, what info they provided, and what the bot did
- "lead_captured": one of: yes / partial / no — "yes" if name + phone or email were provided, "partial" if only name or only contact info, "no" if neither
- "escalated": "yes" if the bot said it would have a staff member or owner follow up, otherwise "no"
- "outcome": one of: booked / no_response / lost — use "booked" if customer expressed clear intent to proceed or was handed off for a quote, "lost" if they declined, "no_response" if unclear
- "faq_questions": array of any questions the customer asked that the bot could NOT answer or said it would need to check on (array of strings, or empty array)
- "address": customer's property address if mentioned (string or null)
- "yard_size": if mentioned — small/medium/large (string or null)
- "special_notes": any specific concerns or details about the property the customer mentioned — gate codes, dogs, slopes, overgrown, preferred schedule days, etc. (string or null)

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

  const webhookUrl = client.webhookUrl || process.env.DEFAULT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error(`Client ${clientId} has no webhookUrl and no DEFAULT_WEBHOOK_URL set.`);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, warning: 'No webhook configured' }) };
  }

  try {
    // Step 1: Extract all fields from conversation
    const ex = await extractFromConversation(messages);

    // Step 2: Build payload matching activity_log sheet columns
    const now = new Date().toISOString();
    const durationSec = startTime ? Math.round((Date.now() - new Date(startTime).getTime()) / 1000) : null;

    const activityPayload = {
      // ── activity_log columns ──
      timestamp: startTime || now,
      client_id: clientId,
      agent: '01',
      event_type: 'lead_captured',
      recipient_phone: ex.recipient_phone || '',
      recipient_email: ex.recipient_email || '',
      recipient_name: ex.recipient_name || '',
      message_body: ex.summary || '',
      status: 'delivered',
      source: 'chatbot_webhook',
      claude_used: 'yes',
      notes: [
        ex.special_notes || '',
        ex.address ? 'Address: ' + ex.address : '',
        ex.yard_size ? 'Yard size: ' + ex.yard_size : '',
        (ex.faq_questions && ex.faq_questions.length > 0) ? 'Unanswered FAQs: ' + ex.faq_questions.join('; ') : ''
      ].filter(Boolean).join(' | ') || '',
      outcome: ex.outcome || 'no_response',
      revenue: null,
      intent: ex.intent || 'general',
      service: ex.service || '',
      response_time_sec: durationSec,
      star_rating: null,
      sequence_info: null,
      platform: 'website',

      // ── extra fields for Make.com routing & storage ──
      session_id: sessionId || 'nl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      conversation_json: JSON.stringify(messages),
      message_count: messages.length,
      lead_captured: ex.lead_captured || 'no',
      escalated: ex.escalated || 'no',
      duration_sec: durationSec,
      faq_questions: ex.faq_questions || [],
      address: ex.address || '',
      yard_size: ex.yard_size || ''
    };

    // Step 3: Send to Make.com webhook
    await sendToWebhook(webhookUrl, activityPayload);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error('save-lead error:', e);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'Lead save failed (logged)' }) };
  }
};
