# Neural Local — Multi-Tenant Chat Widget

One Netlify deployment. Many clients. Zero client-site code changes.

## How it works

1. Every client has a JSON file in `/clients/<clientId>.json` holding their system prompt, branding, and allowed domains.
2. The client pastes a single `<script>` tag into their site:
   ```html
   <script async
     src="https://YOUR-NEURAL-LOCAL-DOMAIN/embed.js"
     data-client-id="their-client-id"></script>
   ```
3. `embed.js` fetches `/config?clientId=…` (public-safe fields only), renders the widget on top of the client's page, and sends messages to `/chat`.
4. `/chat` loads the server-side client config, enforces the allowed-domain list, and calls the Anthropic API using the server-side `ANTHROPIC_API_KEY`.

The system prompt **never** leaves the server. Clients can't be swapped by tampering with the browser.

## Folder layout

```
neural-local-chatbot/
├── netlify.toml                  # Netlify build/headers config
├── clients/
│   ├── _template.json            # Copy this when onboarding a new client
│   └── lumiere-med-spa.json      # Example client
├── netlify/functions/
│   ├── chat.js                   # POST /chat  — multi-tenant Anthropic call
│   └── config.js                 # GET  /config — public-safe client config
└── public/
    ├── embed.js                  # The single-file widget clients embed
    └── index.html                # Landing page
```

## Deploying

1. Push this repo to GitHub.
2. Connect it to Netlify as a new site.
3. In Netlify → Site settings → Environment variables, add:
   - `ANTHROPIC_API_KEY` = your Anthropic key
4. Deploy. Your site is now at `https://<something>.netlify.app` (or your custom domain).

## Onboarding a new client

See `ONBOARDING.md` (the Google Doc / Word doc version) for the full walkthrough. Short version:

1. Copy `clients/_template.json` to `clients/<new-client-id>.json`.
2. Fill in businessName, assistantName, greeting, theme, allowedDomains, and systemPrompt.
3. Commit and push. Netlify auto-deploys in ~60 seconds.
4. Give the client their embed snippet with their `clientId`.
