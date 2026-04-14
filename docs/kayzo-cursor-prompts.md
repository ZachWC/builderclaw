# Kayzo Backend -- Individual Cursor Prompts

Use these in order. Do not move to the next prompt until the current one works. Each prompt is self-contained.

---

## PROMPT 1 -- Verify the fork runs

I have forked the OpenClaw repository from github.com/openclaw/openclaw. This is a TypeScript Node 24 pnpm monorepo.

1. Check that package.json exists and key directories are present: src/, extensions/, skills/, packages/, apps/, ui/
2. Verify Node 24 is available: node --version
3. Run pnpm install and fix any dependency errors
4. Run pnpm build and fix any build errors
5. Find where the config directory path is defined in src/ -- the constant that sets ~/.openclaw/ as the config path. Report the exact file and line.
6. Check if there is any existing mechanism to override the config path via environment variable. If not, note it -- we will add one.

Do not make any changes yet. Report what you found.

---

## PROMPT 2 -- Rename to Kayzo, add config override, disable WebChat

Three changes in one prompt because they are all small and interconnected.

RENAME:
1. In package.json: change name to "kayzo", change bin from { "openclaw": "openclaw.mjs" } to { "kayzo": "kayzo.mjs" }
2. Rename openclaw.mjs to kayzo.mjs
3. Find the config directory constant in src/ and update the config loading to check KAYZO_CONFIG env var first, falling back to ~/.kayzo/kayzo.json. Change at the source definition only -- not a mass string replace.
4. Find daemon service names in launchd template (macOS) and systemd template (Linux) and change to "kayzo"
5. In ui/ replace text "OpenClaw" with "Kayzo"

DISABLE WEBCHAT:
6. Find where the WebChat is enabled in the default config and in src/. The web app replaces WebChat entirely. Set WebChat to disabled by default. When KAYZO_CONFIG is set, the customer config has webchat.enabled: false explicitly. Confirm the WebChat UI is not served when disabled.

TRACK CHANGES:
7. Create KAYZO.md at the repo root listing every file modified from upstream

8. Run pnpm build -- confirm zero errors
9. Test KAYZO_CONFIG override: KAYZO_CONFIG=/tmp/test.json node kayzo.mjs gateway -- confirm it attempts to load /tmp/test.json (will fail because file does not exist -- that error confirms the override works)

---

## PROMPT 3 -- Create construction skills

Create four skill files.

1. Create skills/kayzo/SKILL.md:

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
- When a contractor provides dimensions or specs, calculate material quantities
- Apply current pricing from supplier emails and memory where available
- Apply the contractor's standard markup from preferences
- Generate a line-item bid with materials, labor estimates, and total
- Format clearly enough to send directly to a homeowner

Approval rules:
- Always use the approval queue for any action involving money, ordering, or scheduling
- Apply the contractor's autonomy preferences before deciding to queue or execute
- Every approval queue item must include a preferences_category field: ordering, scheduling, email_replies, or flagging

Construction knowledge:
- Material categories: lumber, concrete, steel, MEP, roofing, finishes
- Trades: framing, electrical, plumbing, HVAC, concrete, roofing, drywall, painting
- POs need: supplier, line items with quantities/units, pricing, delivery address, requested delivery date, PO number
- Regional pricing varies -- flag if a price seems unusual

Memory:
- Remember preferred suppliers per material category
- Remember approval thresholds and autonomy preferences
- Remember recurring orders and flag when reorder time approaches
- Remember subcontractor contact preferences and reliability notes
- Remember the contractor's standard markup percentage and bid format preferences

2. Create skills/kayzo/EMAIL.md with the email classification and processing workflow.

3. Create skills/kayzo/PREFERENCES.md -- this is a template file. The license plugin will replace placeholders with actual values and write a resolved version to the workspace as a bootstrap context file each session. Content:

## Autonomy settings

Ordering (placing POs, requesting quotes): {ORDERING_MODE} {ORDERING_THRESHOLD_TEXT}
Scheduling (confirming/changing sub commitments): {SCHEDULING_MODE}
Email replies (responding to suppliers and subs): {EMAIL_REPLIES_MODE}
Flagging (urgent alerts, pricing issues): {FLAGGING_MODE}
Bid markup: {MARKUP_PERCENTAGE}%

Mode definitions:
- always_ask: add to approval queue, never execute, wait for contractor approval
- threshold: execute if dollar amount is under threshold, queue if at or above
- always_act: execute immediately and log

For every action:
1. Identify the category (ordering, scheduling, email_replies, flagging)
2. Check the mode for that category
3. If threshold mode, check the dollar amount against the threshold
4. Execute or add to approval queue accordingly

When adding to the approval queue always include:
- What the action is and full context
- Dollar amount or commitment
- Which preference rule is holding it
- What happens if declined
- preferences_category set to one of: ordering, scheduling, email_replies, flagging

4. Create skills/kayzo/ONBOARDING.md:

If memory does not contain a note saying "onboarding completed", run this once before anything else:

Say: "Welcome to Kayzo. Four quick questions to set up how I work for you -- about 2 minutes."

Ask one at a time, wait for answer before next:
1. "When I want to place a material order, should I always check with you first? Or automatically handle orders under a dollar amount? If so what's the limit?"
2. "When I want to confirm or change a scheduling commitment with a sub, always check first?"
3. "When I want to reply to a routine supplier email on your behalf, always check first?"
4. "One thing that never needs approval: I will always notify you immediately about urgent issues like safety problems or missed deliveries."

After answers, call update-preferences with their choices.
Say: "Perfect. You can update these anytime by saying 'update my preferences'."
Log to memory: "Onboarding completed {date}. Preferences: {summary}"

5. Find how OpenClaw loads bundled skills and confirm all four skill files will be loaded automatically from skills/kayzo/. If only SKILL.md is supported per directory, combine all content into SKILL.md.

6. Add skills/kayzo/ to KAYZO.md

7. Test locally: start the gateway and ask "I need a bid for 2,400 sq ft house, standard framing. What information do you need?" -- confirm the agent responds as a construction assistant.

---

## PROMPT 4 -- Supabase schema and Edge Functions

Generate everything needed to deploy the Supabase backend.

1. Generate supabase/migrations/001_initial.sql with the complete schema:

customers table (id, email, name, slug unique, stripe_customer_id, license_key unique, subscription_status default trialing, subscription_tier default cloud, free_account boolean default false, monthly_token_budget integer default 500000, current_version text, provisioned_port integer, created_at)

contractor_preferences table (id, license_key unique, ordering_mode default always_ask, ordering_threshold integer default 500, scheduling_mode default always_ask, scheduling_threshold integer default null, email_replies_mode default always_ask, flagging_mode default always_act, bid_markup integer default 20, updated_at)

Trigger: after insert on customers, auto-create default preferences record.

contractor_memory table (id, license_key unique, memory_data jsonb, updated_at)

license_checks table (id, license_key, checked_at, result)

usage_logs table (id, license_key, month, input_tokens default 0, output_tokens default 0, updated_at, unique on license_key+month)

increment_usage RPC function (atomic upsert into usage_logs)

Enable RLS on all tables, no policies (service role key used from Edge Functions).

2. Generate five Edge Function files:

supabase/functions/validate-license/index.ts
  Takes { license_key }
  Returns { valid, tier, status, freeAccount, gatewayType, gatewayUrl, overBudget, tokensUsed, tokenBudget }
  valid = true if status is trialing or active

supabase/functions/get-preferences/index.ts
  Takes { license_key }
  Returns { ordering: { mode, threshold }, scheduling: { mode, threshold }, emailReplies: { mode }, flagging: { mode }, bidMarkup }

supabase/functions/update-preferences/index.ts
  Takes { license_key, preferences } partial update object
  Validates mode values: always_ask, threshold, always_act
  Validates threshold as positive integer or null
  Upserts contractor_preferences
  Writes a timestamp to a refresh flag at /tmp/kayzo-prefs-refresh-{license_key} -- the license plugin watches for this
  Returns { ok: true }

supabase/functions/log-usage/index.ts
  Takes { license_key, input_tokens, output_tokens }
  Calls increment_usage RPC
  Returns { ok: true }

supabase/functions/stripe-webhook/index.ts
  Verifies Stripe signature
  customer.subscription.*: updates subscription_status
  invoice.payment_failed: sets subscription_status to past_due
  Returns { received: true }

3. Generate supabase/test-functions.sh with curl commands to test all five functions manually after deployment.

---

## PROMPT 5 -- VPS server setup

Create scripts/setup-server.sh for a fresh Ubuntu 24 VPS.

The script must:
1. Install Node 24 via fnm for the kayzo system user
2. Install pnpm and PM2 globally
3. Install Caddy via the official apt repository (not snap)
4. Create kayzo user with home /home/kayzo and directories /home/kayzo/app/ and /home/kayzo/customers/
5. Clone the Kayzo repo (use REPO_URL variable at top of script)
6. Run pnpm install && pnpm build in /home/kayzo/app/
7. Set up PM2 startup for kayzo user: pm2 startup systemd -u kayzo
8. Write /etc/caddy/Caddyfile:

   {
     email admin@kayzo.ai
   }

   api.kayzo.ai {
     reverse_proxy localhost:9000
   }

9. Enable and start Caddy
10. Set up UFW: allow 22, 80, 443
11. Write /home/kayzo/app/.env with placeholder lines for: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID
12. Print checklist of remaining manual steps including DNS setup

The script must be idempotent -- safe to run multiple times.

At the top of the script add a comment block:
DNS records to create before running this script:
  A record: api.kayzo.ai -> [your VPS IP]

---

## PROMPT 6 -- Gateway API router

The web app connects to customer gateway instances through a routing service. Build it.

Create extensions/kayzo-router/ -- a Node.js Express server with WebSocket proxy support that runs as a separate PM2 process on port 9000.

It must handle:

WebSocket connections at /ws/{slug}:
1. Read the Authorization header (Bearer {supabase_jwt})
2. Validate the JWT using Supabase's JWT verification (use the SUPABASE_JWT_SECRET env var or call Supabase to verify)
3. Look up the customer with that slug in Supabase customers table
4. Verify the JWT's sub (user ID) matches the customer's auth user ID (add auth_user_id column to customers table)
5. Fetch provisioned_port for that customer from Supabase
6. Proxy the WebSocket connection to localhost:{provisioned_port}
7. If the gateway instance is unreachable, return a 503 with a clear error message

REST requests at /api/preferences/{slug}:
- GET: fetch from contractor_preferences in Supabase and return
- PATCH: validate and upsert to contractor_preferences, write refresh flag file, return { ok: true }
- Require valid JWT in Authorization header, verify slug matches JWT user

REST requests at /api/{slug}/* (for Gmail webhook forwarding):
- Proxy to localhost:{provisioned_port}/{remaining_path}
- No auth required (Gmail webhooks cannot send auth headers)
- Rate limit: max 100 requests per minute per slug to prevent abuse

Health check at /health:
- Return { ok: true, timestamp } with 200

The router reads the Supabase service role key from the shared /home/kayzo/app/.env file.

PM2 setup: add kayzo-router to the provisioning setup so it starts automatically.

Start the router with: pm2 start /home/kayzo/app/router.mjs --name kayzo-router

Test by:
1. Start the router: pm2 start kayzo-router
2. Check health: curl https://api.kayzo.ai/health
3. Provision a test customer and try to connect via WebSocket using a valid JWT
4. Confirm the connection proxies correctly to the customer's gateway

Add extensions/kayzo-router/ to KAYZO.md.

---

## PROMPT 7 -- License, usage, and preferences plugin

Build the core plugin that handles license validation, usage tracking, and preferences injection.

First, read 2-3 existing plugins in extensions/ to understand the plugin structure and hook registration. Do this before writing any code.

Build extensions/kayzo-license/ that does:

STARTUP (hook: gateway_start):
1. Read license_key and supabaseUrl from config (loaded via KAYZO_CONFIG)
2. Call validate-license and get-preferences Edge Functions in parallel
3. Cache license result to {workspace}/../license-cache.json with ISO timestamp
4. Write preferences to the preferences block in the local kayzo.json config
5. Generate {workspace}/../preferences-context.md by reading skills/kayzo/PREFERENCES.md and substituting:
   - {ORDERING_MODE} with actual value
   - {ORDERING_THRESHOLD_TEXT} with "Auto-approve under ${threshold}" if threshold mode, empty otherwise
   - {SCHEDULING_MODE}, {EMAIL_REPLIES_MODE}, {FLAGGING_MODE} with actual values
   - {MARKUP_PERCENTAGE} with bid_markup value
6. Register preferences-context.md as a bootstrap context file (find how OpenClaw loads AGENTS.md and bootstrap files from https://docs.openclaw.ai/concepts/context and use the same mechanism)
7. Update customers.current_version via Supabase REST PATCH -- fire and forget
8. Log: "Kayzo v{version} -- {slug} -- license: valid/invalid"

AFTER EVERY AI RESPONSE (hook: agent_end):
9. Extract input_tokens and output_tokens from the response usage metadata
10. Fire-and-forget POST to log-usage Edge Function -- never await this

PREFERENCES REFRESH WATCHER:
11. Every 60 seconds, check if a refresh flag file exists at /tmp/kayzo-prefs-refresh-{license_key}
12. If found: re-fetch preferences, update config, regenerate preferences-context.md, delete the flag file
13. Log: "Preferences refreshed for {slug}"

PERIODIC RE-VALIDATION (every 24 hours):
14. Re-call validate-license and get-preferences
15. Update cache and regenerate preferences-context.md

BUDGET ALERT:
16. If validate-license returns overBudget: true, log warning and append to {workspace}/../budget-alerts.log

Follow existing plugin patterns exactly. Use plugin-sdk/ types only.

Add extensions/kayzo-license/ to KAYZO.md.

Test:
1. Set KAYZO_CONFIG to a test config with a valid license_key
2. Start gateway and confirm license check in logs
3. Confirm preferences-context.md was generated in the workspace directory
4. Send a message and confirm usage logging fires (check usage_logs in Supabase)
5. Update a preference directly in Supabase, wait 60 seconds, confirm preferences-context.md regenerates

---

## PROMPT 8 -- Customer provisioning script

Build the provisioning script that sets up a new customer end to end.

Create scripts/provision-customer.sh taking --name, --email, --slug, optional --free, and optional --local:

If --local is passed the script only creates the Supabase record -- it does NOT assign a port, does NOT create a customer directory, does NOT start a PM2 process, and does NOT update Caddy. Local customers run the gateway on their own machine. Set gateway_type = 'local' and gateway_url = null in Supabase for local customers.

If --local is not passed (default cloud behavior), run the full provisioning flow as described below.


1. Validate inputs -- slug must be lowercase alphanumeric, no existing directory for that slug
2. Generate license_key (UUID) and dashboard password (16 char alphanumeric)
3. Find next available port starting from 3001
4. Create /home/kayzo/customers/{slug}/ directory
5. Write /home/kayzo/customers/{slug}/kayzo.json with all config including:
   - agent.model: anthropic/claude-sonnet-4-6
   - kayzo.licenseKey, customerSlug, supabaseUrl, syncEnabled
   - agents.defaults.memory, workspace path
   - channels.webchat.enabled: false
   - gateway.port, bind: loopback, auth password
   - preferences block with all defaults including bidMarkup: 20

6. Create Supabase records via REST API using service role key:
   - Insert into customers: email, name, slug, license_key, provisioned_port (null if --local), subscription_status (active if --free, trialing otherwise), free_account, gateway_type ('local' if --local, 'cloud' otherwise), gateway_url (null for both -- set later for local customers via set-gateway-url script)
   - Create Supabase Auth user with their email using the admin API: POST /auth/v1/admin/users with { email, email_confirm: true, password: {generated_temp_password} }
   - Supabase sends a password reset email automatically -- contractor sets their own password on first login

7. Add to /etc/caddy/Caddyfile and reload Caddy (may not be needed if router handles all routing via api.kayzo.ai -- include anyway for direct access fallback)

8. Start gateway with PM2:
   pm2 start /home/kayzo/app/kayzo.mjs \
     --name "kayzo-{slug}" \
     --env KAYZO_CONFIG=/home/kayzo/customers/{slug}/kayzo.json \
     -- gateway
   pm2 save

9. Wait 5 seconds and verify process is running

10. Print summary:
    Customer provisioned
    Name: {name}
    Login: https://app.kayzo.ai
    Email: {email}
    Password setup email sent via Supabase
    License: {license_key}
    Port: {port}

Also create scripts/teardown-customer.sh:
- Confirms before proceeding
- Stops PM2 process and removes it
- Asks separately about deleting /home/kayzo/customers/{slug}/
- Updates Supabase subscription_status to canceled

---

## PROMPT 9 -- Stripe and admin scripts

1. Generate Stripe setup checklist:
   - Create product "Kayzo Cloud" at $150/month -- copy price ID to STRIPE_CLOUD_PRICE_ID
   - Create product "Kayzo Local" at $100/month -- copy price ID to STRIPE_LOCAL_PRICE_ID
   - Create Payment Links for both products
   - Webhook to {SUPABASE_URL}/functions/v1/stripe-webhook
   - Events: customer.subscription.created/updated/deleted, invoice.payment_failed
   - Copy webhook secret to STRIPE_WEBHOOK_SECRET

   The stripe-webhook Edge Function must update both subscription_status AND subscription_tier when a subscription is created -- match the Stripe price ID to determine whether to set tier = 'cloud' or tier = 'local'.

2. Confirm stripe-webhook Edge Function from Prompt 4 handles all four event types correctly.

3. Generate scripts/list-customers.ts:
   - Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from env
   - Queries customers joined with usage_logs for current month
   - Prints table: name, slug, type, status, free, version, tokens used
   - type column shows [CLOUD] or [LOCAL] clearly
   - Marks free accounts with [FREE]
   - Marks local customers with no gateway_url set yet as [LOCAL - URL PENDING]
   - Usage: npx tsx scripts/list-customers.ts

4. Generate scripts/provision-local-customer.sh that:
   - Takes --name, --email, --slug, and optional --free
   - Creates the Supabase customer record with gateway_type = 'local', provisioned_port = null, gateway_url = null
   - Creates the Supabase Auth user
   - Prints the license key and instructions to send to the customer
   - Prints: "Once the customer installs Kayzo and shares their Tailscale URL, run: npx tsx scripts/set-gateway-url.ts --slug {slug} --url {url}"

5. Generate scripts/set-gateway-url.ts that:
   - Takes --slug and --url
   - Updates customers.gateway_url in Supabase for that slug
   - Prints confirmation: "Gateway URL set for {slug}: {url}"
   - Usage: npx tsx scripts/set-gateway-url.ts --slug bobsmith --url https://bobsmith-mac.tailnet.ts.net

---

## PROMPT 10 -- Gmail integration

OpenClaw has built-in Gmail Pub/Sub support. Read https://docs.openclaw.ai/automation/gmail-pubsub first.

1. Confirm the correct config keys for Gmail in kayzo.json. Update the config template in provision-customer.sh to include the Gmail config block. The webhook URL for cloud customers is:
   https://api.kayzo.ai/api/{slug}/webhook/gmail
   (the router proxies this to the correct gateway instance)

2. Find where the Gmail trigger fires in the codebase. Trace the path from notification to agent.

3. Confirm EMAIL.md and SKILL.md are both loaded and active for Gmail processing.

4. Write docs/gmail-setup.md -- plain-language setup guide for a non-technical contractor. Include screenshots descriptions, step by step, what to expect after setup.

5. Test: connect a Gmail account to a test gateway instance, send a test supplier email, confirm the agent processes and creates an approval item.

---

## PROMPT 11 -- Memory backup plugin

Build extensions/kayzo-sync/.

Read plugin-sdk/memory-core documentation and source to understand the memory API before writing anything.

The plugin:

STARTUP: Check if local memory store is empty. If empty, fetch contractor_memory from Supabase for this license_key. If record found, hydrate local memory. Log "Memory restored from Supabase backup" if restoration happens.

PERIODIC BACKUP every 30 minutes: Serialize current memory to JSON. Upsert to Supabase contractor_memory. Fire and forget -- do not interrupt agent if it fails. Log errors but continue.

Follow existing plugin patterns. Add to KAYZO.md.

Test:
1. Tell agent something to remember
2. Wait 30 minutes or temporarily reduce interval
3. Check Supabase contractor_memory -- confirm data is there
4. Delete workspace directory
5. Restart gateway
6. Ask agent what it remembers -- confirm restoration from Supabase

---

## PROMPT 12 -- Full backend integration test

Run this checklist end to end. Fix all failures before considering the backend done.

VPS:
[ ] pm2 list shows kayzo-router as online
[ ] Caddy running: systemctl status caddy
[ ] curl https://api.kayzo.ai/health returns { ok: true }
[ ] /home/kayzo/app/.env has all values filled in

PROVISION TEST CUSTOMER (CLOUD):
[ ] Run: ./scripts/provision-customer.sh --name "Test User" --email test@test.com --slug testuser --free
[ ] pm2 list shows kayzo-testuser as online
[ ] Supabase customers table shows testuser with active status, free_account true, gateway_type 'cloud', gateway_url null
[ ] Supabase contractor_preferences shows default preferences for testuser

PROVISION TEST LOCAL CUSTOMER:
[ ] Run: ./scripts/provision-local-customer.sh --name "Local User" --email local@test.com --slug localuser --free
[ ] pm2 list does NOT show kayzo-localuser (correct -- local customer has no VPS process)
[ ] Supabase customers table shows localuser with gateway_type 'local', provisioned_port null, gateway_url null
[ ] Run: npx tsx scripts/set-gateway-url.ts --slug localuser --url https://test-machine.tailnet.ts.net
[ ] Confirm Supabase gateway_url updated for localuser
[ ] Run scripts/list-customers.ts and confirm localuser shows [LOCAL] and testuser shows [CLOUD]

GATEWAY ROUTER:
[ ] WebSocket connection to wss://api.kayzo.ai/ws/testuser with valid JWT succeeds
[ ] Connection proxies to testuser gateway (send a test message, confirm response)
[ ] GET https://api.kayzo.ai/api/preferences/testuser returns default preferences
[ ] PATCH https://api.kayzo.ai/api/preferences/testuser updates ordering_mode

LICENSE AND PREFERENCES:
[ ] pm2 logs kayzo-testuser shows "Kayzo v{version} -- testuser -- license: valid"
[ ] preferences-context.md exists in testuser workspace with actual values
[ ] Update ordering_mode to threshold and threshold to 300 via PATCH to router
[ ] Wait 60 seconds
[ ] Confirm preferences-context.md regenerated with new values

SKILLS:
[ ] Connect to gateway via WebSocket and send: "I need a bid for a 2400 sq ft house, standard framing and drywall"
[ ] Confirm agent responds as construction assistant asking for details

PREFERENCES AUTONOMY:
[ ] Send: "Place an order for 200 2x4 studs from Pacific Coast Lumber for $180 total" -- with threshold at $300, confirm executes automatically
[ ] Send: "Place an order for full lumber package, $2400" -- confirm goes to approval queue
[ ] Confirm approval queue item has preferences_category: ordering

USAGE:
[ ] Check Supabase usage_logs -- confirm tokens accumulating after messages
[ ] Run: npx tsx scripts/list-customers.ts -- confirm testuser shows in table

GMAIL (skip if not configured yet):
[ ] Connect test Gmail
[ ] Send supplier email to that account
[ ] Confirm agent processes it and creates approval item

MEMORY BACKUP:
[ ] Tell agent something specific to remember
[ ] Confirm Supabase contractor_memory record updated within 30 minutes
[ ] Restart gateway: pm2 restart kayzo-testuser
[ ] Confirm agent still knows the information

CLEANUP:
[ ] Remove any logs of sensitive data (keys, passwords, email content)
[ ] KAYZO.md lists all modified upstream files
[ ] pnpm build -- zero errors
[ ] Test teardown: ./scripts/teardown-customer.sh --slug testuser

Report each checkbox result. Fix failures before shipping.

---

## Notes

- Run each prompt in a fresh Cursor composer window with the full codebase in context.
- KAYZO_CONFIG env var (Prompt 2) is the most critical change -- without it multi-tenant does not work.
- The gateway router (Prompt 6) is the bridge between the web app and the backend -- build and test it before the web app is built.
- The web app is a separate project with its own prompts in kayzo-webapp-cursor-prompts.md.
