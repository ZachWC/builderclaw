# Kayzo MVP -- Cursor Build Spec (Cloud-First)

## What we are building

Kayzo is a construction industry AI operations assistant built on top of the OpenClaw fork. It has two parts:

1. Kayzo Backend -- the OpenClaw-based gateway running on a VPS, one instance per customer, handling AI, email, memory, and integrations.
2. Kayzo Web App -- a purpose-built React frontend deployed on Vercel. This is the primary interface contractors use. It replaces the built-in OpenClaw WebChat entirely.

Contractors go to app.kayzo.ai, log in, and get a dedicated interface with messaging, approval queue, preferences, and bid generation. No WhatsApp setup. No navigating to a raw gateway URL. A real product.

---

## System architecture

```
contractor browser/phone
        |
  https://app.kayzo.ai  (Vercel -- React web app)
        |
        | WebSocket + REST
        |
  https://api.kayzo.ai  (your VPS -- gateway API router)
        |
  [Caddy routes to customer gateway instances]
        |
  [PM2: kayzo-bobsmith on port 3001]
  [PM2: kayzo-janesmith on port 3002]
        |
  [Anthropic Claude API]
        |
  [Supabase -- auth, preferences, memory backup, billing]
```

The web app authenticates via Supabase Auth. After login it fetches the customer's record from Supabase which includes their gateway_type (cloud or local) and gateway_url. For cloud customers the web app connects to wss://api.kayzo.ai/ws/{slug}. For local customers it connects to whatever gateway_url is stored for them (their Tailscale URL or similar). All chat, approvals, and preferences flow through that WebSocket connection.

---

## Project 1 -- Kayzo Backend (this spec)

Everything on the VPS side. The OpenClaw fork, plugins, skills, provisioning scripts, Supabase schema, Stripe webhooks.

## Project 2 -- Kayzo Web App (separate spec)

The React frontend. See kayzo-webapp-spec.md.

---

## Tech stack (backend)

- Base: OpenClaw fork (TypeScript, Node 24, pnpm monorepo)
- VPS: Hetzner CX22 or DigitalOcean Basic ($20-40/month) running Ubuntu 24
- Reverse proxy: Caddy (handles HTTPS automatically via Let's Encrypt)
- Process manager: PM2 (keeps all gateway instances running, restarts on crash)
- Cloud backend: Supabase (auth, database, preferences, memory backup)
- Payments: Stripe (monthly subscription, webhook to Supabase)
- AI: Anthropic Claude API (claude-sonnet-4-6) via OpenClaw's existing provider system
- Memory: OpenClaw's built-in memory stored per-customer on VPS disk, backed up to Supabase
- DNS: api.kayzo.ai A record pointing to your VPS IP

The built-in OpenClaw WebChat is disabled for all customer instances. The web app is the only UI.

---

## Repository structure context

Fork of github.com/openclaw/openclaw. Key directories:

- src/ -- core gateway source
- extensions/ -- channel and provider plugins
- skills/ -- skill markdown files
- packages/ -- shared packages
- ui/ -- built-in web UI (disabled for Kayzo -- web app replaces this)

On your VPS:
- /home/kayzo/app/ -- the built Kayzo application
- /home/kayzo/customers/{slug}/ -- per-customer config and data
- /home/kayzo/customers/{slug}/kayzo.json -- customer config file
- /home/kayzo/customers/{slug}/workspace/ -- customer memory and workspace

Do not break existing OpenClaw functionality. Add Kayzo features as additive layers.
Track every modified upstream file in KAYZO.md at the repo root.

---

## Feature 1 -- Kayzo construction skills

### skills/kayzo/SKILL.md

You are Kayzo, an AI operations assistant for general contractors and builders.

Your job:
- Monitor and process incoming emails from suppliers, subcontractors, and job sites
- Generate purchase orders and material orders for contractor review
- Generate bids and estimates from measurements and specs the contractor provides
- Track pricing, availability, and lead times from suppliers
- Manage scheduling communications with subcontractors
- Flag anything that needs immediate attention

How you handle emails:
- Supplier email: extract supplier name, items, quantities, pricing, lead time, action required
- Sub email: extract job site, crew size, materials needed, scheduling request, issues
- Always generate a structured summary before taking any action
- Never place or confirm an order without explicit contractor approval

How you handle bid requests:
- When a contractor provides room or house dimensions, calculate material quantities needed
- Apply current pricing from supplier emails and memory where available
- Apply the contractor's standard markup percentage from their preferences
- Generate a line-item bid with materials, labor estimates, and total
- Format the bid clearly enough to send directly to a homeowner

Approval rules:
- Always use the approval queue for any action involving money, ordering, or scheduling
- Frame approvals clearly: what the action is, what it costs, what happens if declined
- Apply the contractor's autonomy preferences before deciding to queue or execute

Construction knowledge:
- Material categories: lumber, concrete, steel, MEP, roofing, finishes
- Trades: framing, electrical, plumbing, HVAC, concrete, roofing, drywall, painting
- POs need: supplier, line items with quantities and units, pricing, delivery address, requested delivery date, PO number
- Regional pricing varies -- note if a price seems unusual for the region

Memory:
- Remember preferred suppliers per material category
- Remember approval thresholds and autonomy preferences
- Remember recurring orders and flag when reorder time approaches
- Remember subcontractor contact preferences and reliability notes
- Remember the contractor's standard markup percentage and bid format preferences

### skills/kayzo/EMAIL.md

Email processing workflow:

When you receive an email trigger:
1. Read the full email including subject, sender, and body
2. Classify as: SUPPLIER, SUBCONTRACTOR, JOB_SITE, INVOICE, OTHER
3. SUPPLIER: extract supplier name, items, quantities, pricing, deadlines, action required
4. SUBCONTRACTOR: extract trade, job site, crew/scheduling info, materials, problems
5. INVOICE: extract vendor, amount, due date, PO number -- flag for approval
6. JOB_SITE: extract site name, issue, urgency level
7. OTHER: summarize briefly, flag if action needed

After classification:
- Action required: create approval queue item with full context
- Informational: log brief summary and continue
- Urgent (safety, missed delivery, overdue payment): flag immediately

Always respond in plain language. The contractor is on a job site, not at a desk.

### skills/kayzo/PREFERENCES.md

This file is regenerated per customer by the license plugin on startup.
The template below has placeholders replaced with actual values.

## Autonomy settings

Ordering (placing POs, requesting quotes): {ORDERING_MODE} {ORDERING_THRESHOLD_TEXT}
Scheduling (confirming/changing sub commitments): {SCHEDULING_MODE}
Email replies (responding to suppliers and subs): {EMAIL_REPLIES_MODE}
Flagging (urgent alerts, pricing issues): {FLAGGING_MODE}
Bid markup: {MARKUP_PERCENTAGE}%

Mode definitions:
- always_ask: add to approval queue, never execute, wait for contractor approval
- threshold: execute if dollar amount is under threshold, queue if at or above threshold
- always_act: execute immediately and log

For every action you consider:
1. Identify the category
2. Check the mode for that category
3. If threshold mode, check the dollar amount
4. Execute or queue accordingly

When adding to the approval queue always include:
- What the action is and full context
- Dollar amount or commitment
- Which preference rule is holding it
- What happens if declined
- The preferences_category field set to one of: ordering, scheduling, email_replies, flagging

### skills/kayzo/ONBOARDING.md

If memory does not contain a note saying "onboarding completed", run this once before anything else:

Say: "Welcome to Kayzo. I want to make sure I work exactly the way you want. Four quick questions -- takes about 2 minutes."

Ask one at a time:
1. "When I want to place a material order, should I always check with you first? Or automatically handle orders under a dollar amount? If so, what's the limit?"
2. "When I want to confirm or change a scheduling commitment with a sub, always check first?"
3. "When I want to reply to a routine supplier email on your behalf, always check first?"
4. "One thing that never needs approval: I will always notify you immediately about urgent issues like safety problems or missed deliveries."

After answers, call update-preferences with their choices.
Say: "Perfect. You can update these anytime by saying 'update my preferences'. Let's get started."
Log to memory: "Onboarding completed {date}. Preferences: {summary}"

---

## Feature 2 -- VPS server setup

Create scripts/setup-server.sh that runs once on a fresh Ubuntu 24 VPS:

1. Install Node 24 via fnm
2. Install pnpm globally
3. Install PM2 globally: npm install -g pm2
4. Install Caddy via the official Caddy apt repository
5. Create kayzo user and directories: /home/kayzo/app/ and /home/kayzo/customers/
6. Clone the Kayzo repo into /home/kayzo/app/
7. Run pnpm install and pnpm build
8. Set up PM2 startup: pm2 startup systemd -u kayzo
9. Write base Caddyfile at /etc/caddy/Caddyfile:

   {
     email admin@kayzo.ai
   }

   # Gateway API router -- web app connects here
   api.kayzo.ai {
     reverse_proxy localhost:9000
   }

10. Enable and start Caddy
11. Set up UFW: allow 22, 80, 443
12. Write /home/kayzo/app/.env with placeholders for all env vars
13. Print checklist of remaining manual steps

DNS setup (manual before running script):
- A record: api.kayzo.ai -> [VPS IP]
- A record: *.kayzo.ai -> [VPS IP] (for per-customer gateway ports if needed)

---

## Feature 3 -- Gateway API router

The web app needs to connect to each customer's gateway instance via WebSocket. Rather than exposing each gateway port directly, run a small routing service on port 9000 that the web app connects to.

Create extensions/kayzo-router/ -- a lightweight Express + http-proxy server that:

1. Accepts incoming WebSocket connections at api.kayzo.ai/ws/{slug}
2. Validates the request has a valid Supabase JWT in the Authorization header
3. Verifies the JWT's user_id matches the customer with that slug in Supabase
4. Proxies the WebSocket connection to localhost:{customer_port} where customer_port is read from the customers table in Supabase
5. Accepts REST requests at api.kayzo.ai/api/{slug}/* and proxies them to the correct gateway instance

This router runs as its own PM2 process: kayzo-router on port 9000.

Also expose a public endpoint at api.kayzo.ai/api/preferences/{slug} that:
- GET: returns contractor preferences from Supabase
- PATCH: updates contractor preferences in Supabase and triggers a config refresh on the gateway

---

## Feature 4 -- Customer provisioning

Create scripts/provision-customer.sh that takes --name, --email, --slug, optional --free, and optional --local:

1. Generate license_key (UUID) and dashboard password (16 chars alphanumeric)
2. Find next available port starting from 3001
3. Create /home/kayzo/customers/{slug}/ directory
4. Write /home/kayzo/customers/{slug}/kayzo.json:

{
  "agent": { "model": "anthropic/claude-sonnet-4-6" },
  "kayzo": {
    "licenseKey": "{license_key}",
    "customerSlug": "{slug}",
    "supabaseUrl": "https://YOUR_PROJECT.supabase.co",
    "syncEnabled": true
  },
  "agents": {
    "defaults": {
      "memory": { "enabled": true, "storage": "local" },
      "workspace": "/home/kayzo/customers/{slug}/workspace"
    }
  },
  "channels": {
    "webchat": { "enabled": false }
  },
  "gateway": {
    "port": {port},
    "bind": "loopback",
    "auth": { "mode": "password", "password": "{password}" }
  },
  "preferences": {
    "ordering": { "mode": "always_ask", "threshold": 500 },
    "scheduling": { "mode": "always_ask", "threshold": null },
    "emailReplies": { "mode": "always_ask" },
    "flagging": { "mode": "always_act" },
    "bidMarkup": 20
  }
}

5. Create Supabase records:
   - customers table: email, name, slug, license_key, provisioned_port, gateway_type ('cloud' always for this script -- local provisioning is manual), gateway_url (null for cloud)
   - contractor_preferences table: license_key with default values
   - Create Supabase Auth user with their email (they set password on first login)

6. Add to Caddyfile and reload Caddy
7. Start gateway with PM2 (webchat disabled)
8. Print summary with the app.kayzo.ai login URL

Also create scripts/teardown-customer.sh as before.

---

## Feature 5 -- Persistent memory

Memory persists on VPS disk at /home/kayzo/customers/{slug}/workspace/.

Supabase backup (safety net):
Create extensions/kayzo-sync/ plugin that every 30 minutes backs up memory to Supabase contractor_memory table. Recovery only -- primary persistence is disk.

---

## Feature 6 -- Auth, licensing, usage, and preferences

### Full Supabase schema

  create table customers (
    id uuid primary key default gen_random_uuid(),
    email text unique not null,
    name text,
    slug text unique not null,
    stripe_customer_id text,
    license_key text unique not null default gen_random_uuid()::text,
    subscription_status text default 'trialing',
    subscription_tier text default 'cloud',
    free_account boolean default false,
    monthly_token_budget integer default 500000,
    current_version text,
    provisioned_port integer,
    gateway_type text default 'cloud',
    gateway_url text default null,
    created_at timestamptz default now()
  );
  -- gateway_type values: cloud, local
  -- gateway_url: null for cloud customers (router handles routing), set to Tailscale URL for local customers

  create table contractor_preferences (
    id uuid primary key default gen_random_uuid(),
    license_key text unique not null,
    ordering_mode text default 'always_ask',
    ordering_threshold integer default 500,
    scheduling_mode text default 'always_ask',
    scheduling_threshold integer default null,
    email_replies_mode text default 'always_ask',
    flagging_mode text default 'always_act',
    bid_markup integer default 20,
    updated_at timestamptz default now()
  );

  create or replace function create_default_preferences()
  returns trigger as $$
  begin
    insert into contractor_preferences (license_key)
    values (NEW.license_key);
    return NEW;
  end;
  $$ language plpgsql;

  create trigger on_customer_created
    after insert on customers
    for each row execute procedure create_default_preferences();

  create table contractor_memory (
    id uuid primary key default gen_random_uuid(),
    license_key text unique not null,
    memory_data jsonb not null,
    updated_at timestamptz default now()
  );

  create table license_checks (
    id uuid primary key default gen_random_uuid(),
    license_key text not null,
    checked_at timestamptz default now(),
    result text not null
  );

  create table usage_logs (
    id uuid primary key default gen_random_uuid(),
    license_key text not null,
    month text not null,
    input_tokens integer default 0,
    output_tokens integer default 0,
    updated_at timestamptz default now(),
    unique(license_key, month)
  );

  create or replace function increment_usage(
    p_license_key text,
    p_month text,
    p_input_tokens integer,
    p_output_tokens integer
  ) returns void as $$
  begin
    insert into usage_logs (license_key, month, input_tokens, output_tokens)
    values (p_license_key, p_month, p_input_tokens, p_output_tokens)
    on conflict (license_key, month)
    do update set
      input_tokens = usage_logs.input_tokens + excluded.input_tokens,
      output_tokens = usage_logs.output_tokens + excluded.output_tokens,
      updated_at = now();
  end;
  $$ language plpgsql;

### Supabase Edge Functions

validate-license/index.ts:
  Takes { license_key }
  Returns { valid, tier, status, freeAccount, gatewayType, overBudget, tokensUsed, tokenBudget }

get-preferences/index.ts:
  Takes { license_key }
  Returns full preferences object including bid_markup

update-preferences/index.ts:
  Takes { license_key, preferences } partial update
  Validates mode values: always_ask, threshold, always_act
  Validates threshold as positive integer or null
  Upserts contractor_preferences
  Triggers a config refresh signal (write a timestamp to a refresh flag file the license plugin watches)
  Returns { ok: true }

log-usage/index.ts:
  Takes { license_key, input_tokens, output_tokens }
  Calls increment_usage RPC
  Returns { ok: true }

stripe-webhook/index.ts:
  Verifies Stripe signature
  customer.subscription.*: updates subscription_status
  invoice.payment_failed: sets subscription_status to past_due
  Returns { received: true }

### License plugin: extensions/kayzo-license/

On startup:
1. Read license_key and supabaseUrl from config
2. Call validate-license and get-preferences in parallel
3. Cache license result to license-cache.json (24hr offline fallback)
4. Write preferences to config preferences block
5. Generate {workspace}/../preferences-context.md with actual values substituted
6. Register preferences-context.md as bootstrap context
7. Update customers.current_version in Supabase
8. Log: "Kayzo v{version} -- customer: {slug} -- type: {gateway_type} -- license: valid"

After every AI response:
- Fire-and-forget POST to log-usage with token counts

Watch for preferences refresh:
- Check for a refresh flag file every 60 seconds
- If found, re-fetch preferences, update config, regenerate preferences-context.md, delete flag file

Every 24 hours:
- Re-validate license
- Re-sync preferences

---

## Feature 7 -- API usage protection

Manual step first: console.anthropic.com > Billing > set $100/month spend cap with 80% alert.

Per-customer: monthly_token_budget (default 500k tokens). If overBudget is true from validate-license, log warning to budget-alerts.log. Do not cut off automatically -- alert yourself.

---

## Feature 8 -- Stripe payments

Two tiers: Cloud at $150/month, Local at $100/month.

1. Create product "Kayzo Cloud" at $150/month in Stripe dashboard
2. Create product "Kayzo Local" at $100/month in Stripe dashboard
3. Create Payment Links for both products
4. Webhook to {SUPABASE_URL}/functions/v1/stripe-webhook
5. Listen for subscription and payment events
6. Store both price IDs as env vars: STRIPE_CLOUD_PRICE_ID and STRIPE_LOCAL_PRICE_ID
7. Free customers: provisioning script sets active + free_account = true directly

Note: subscription_tier in Supabase should match the Stripe product. Cloud customers have tier = 'cloud', local customers have tier = 'local'. The stripe-webhook Edge Function should update both subscription_status and subscription_tier when a subscription is created or changed.

---

## Feature 9 -- Gmail integration

OpenClaw built-in Gmail Pub/Sub. Docs: https://docs.openclaw.ai/automation/gmail-pubsub

Webhook URL for cloud customers: https://api.kayzo.ai/api/{slug}/webhook/gmail (proxied by the router to the correct gateway instance)

Contractor follows Gmail setup once during onboarding. Create docs/gmail-setup.md as a plain-language guide.

---

## Admin scripts

scripts/list-customers.ts:
  Prints table: name, slug, email, type (cloud/local), status, free, version, tokens this month
  Type column shows [CLOUD] or [LOCAL] clearly
  Usage: npx tsx scripts/list-customers.ts

---

## Local customer provisioning notes

When a customer wants to run Kayzo on their own device instead of your VPS:

1. Do NOT run provision-customer.sh with the normal flow -- no port is assigned, no PM2 process is started on your VPS
2. Create the Supabase record manually or via a separate script scripts/provision-local-customer.sh:
   - Same fields as cloud but gateway_type = 'local', provisioned_port = null
   - gateway_url is set after the customer installs and gets their Tailscale URL
3. Create Supabase Auth user the same way -- they still log into app.kayzo.ai
4. Send the customer the installer script (built in a future spec) and their license key
5. Once they install and tell you their Tailscale URL, update gateway_url in Supabase:
   UPDATE customers SET gateway_url = 'https://their-machine.tailnet.ts.net' WHERE slug = 'slug'
6. The web app reads gateway_url on login -- when it is set, it connects there instead of the cloud router

Create scripts/provision-local-customer.sh that:
- Takes --name, --email, --slug, and optional --free
- Creates the Supabase customer record with gateway_type = 'local', provisioned_port = null, gateway_url = null
- Creates the Supabase Auth user
- Prints a summary including the license key to send to the customer
- Prints a reminder: "Once the customer installs Kayzo and shares their Tailscale URL, run: npx tsx scripts/set-gateway-url.ts --slug {slug} --url {url}"

Create scripts/set-gateway-url.ts that:
- Takes --slug and --url
- Updates customers.gateway_url in Supabase for that slug
- Prints confirmation
- Usage: npx tsx scripts/set-gateway-url.ts --slug bobsmith --url https://bobsmith-mac.tailnet.ts.net

---

## Build order for MVP

1. Get fork running locally -- pnpm install && pnpm build
2. Rename to Kayzo -- package name, binary name, KAYZO_CONFIG env var
3. Disable WebChat -- set webchat.enabled to false in default config, confirm UI is not served
4. Create construction skills -- SKILL.md, EMAIL.md, PREFERENCES.md template, ONBOARDING.md
5. Set Anthropic spend cap -- console.anthropic.com, $100/month
6. Set up Supabase -- run full schema migration, deploy all five Edge Functions
7. Set up VPS -- rent server, run setup-server.sh, set DNS records
8. Build gateway router -- extensions/kayzo-router/, test WebSocket proxying
9. Build license and usage plugin -- extensions/kayzo-license/ with preferences sync and context file generation
10. Build preferences -- test full flow: Supabase update -> flag file -> config refresh -> new context injected
11. Write provisioning script -- test full provision including Supabase Auth user creation
12. Enable Gmail -- connect test account, verify webhook routes through router to correct gateway
13. Build memory backup plugin -- extensions/kayzo-sync/
14. Set up Stripe -- product, payment link, webhook
15. Provision first real customer -- run script, confirm they can log into app.kayzo.ai (once web app is built)

---

## What is explicitly out of scope for this spec

- The web app UI (covered in kayzo-webapp-spec.md)
- Dedicated device / self-hosted tier
- Multi-user / team accounts
- Self-serve signup
- Ollama / local model support
- Automated teardown on payment failure

---

## Environment variables

Set in /home/kayzo/app/.env on the VPS:

  ANTHROPIC_API_KEY=
  SUPABASE_URL=
  SUPABASE_ANON_KEY=
  SUPABASE_SERVICE_ROLE_KEY=
  STRIPE_SECRET_KEY=
  STRIPE_WEBHOOK_SECRET=
  STRIPE_CLOUD_PRICE_ID=
  STRIPE_LOCAL_PRICE_ID=

---

## Notes for Cursor

- pnpm monorepo. Always use pnpm not npm.
- Gateway started with: kayzo gateway. Dev: pnpm gateway:watch
- TypeScript is strict. No any types.
- New plugins go in extensions/kayzo-*/ following existing plugin patterns.
- Use plugin-sdk/ types only.
- Skills are markdown files. Keep under 500 lines.
- KAYZO_CONFIG env var must override the config path -- critical for multi-tenant.
- WebChat must be disabled -- the web app is the only UI.
- All shell scripts in scripts/ must be POSIX-compatible.
- Track every modified upstream file in KAYZO.md.
- When in doubt about OpenClaw internals check https://docs.openclaw.ai
