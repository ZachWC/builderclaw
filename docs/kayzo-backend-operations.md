# Kayzo Backend — Operations Guide

Everything you need to operate, debug, and extend the Kayzo backend.

---

## What the backend is

Kayzo runs one OpenClaw gateway process per customer on a Hetzner VPS. A shared router process (kayzo-router) sits in front of all gateways and handles authentication, WebSocket proxying, and webhook routing. All state lives in Supabase.

```
browser / web app
      |
https://api.kayzo.app   (Caddy — TLS termination)
      |
      port 9000          kayzo-router (PM2)
      |
      port 3001+         kayzo-{slug} gateway per customer (PM2)
      |
Anthropic Claude API + Supabase
```

---

## VPS details

| Field         | Value                           |
| ------------- | ------------------------------- |
| Provider      | Hetzner CPX21                   |
| OS            | Ubuntu 24.04                    |
| IP            | 5.78.195.230                    |
| User          | kayzo (app) / root (admin)      |
| App directory | `/home/kayzo/app`               |
| Customer data | `/home/kayzo/customers/{slug}/` |
| Env file      | `/home/kayzo/app/.env`          |

---

## How to SSH in

```bash
ssh root@5.78.195.230
```

If you set up your SSH key during Hetzner server creation it will log straight in. No password needed.

---

## Process management (PM2)

PM2 runs as the `kayzo` user. Always prefix PM2 commands with the fnm environment setup:

```bash
sudo -u kayzo bash --login -c "
  export HOME=/home/kayzo
  export PATH=\"\$HOME/.fnm:\$PATH\"
  eval \"\$(fnm env --shell bash)\"
  pm2 list
"
```

### Common PM2 commands

```bash
# List all processes
pm2 list

# View logs for a process
pm2 logs kayzo-testuser --lines 50 --nostream

# Restart a process
pm2 restart kayzo-router --update-env

# Stop and remove a process
pm2 delete kayzo-testuser

# Save process list (survives reboot)
pm2 save
```

### Processes that should always be running

| Name           | Port  | Description                                               |
| -------------- | ----- | --------------------------------------------------------- |
| `kayzo-router` | 9000  | API router — proxies all traffic to per-customer gateways |
| `kayzo-{slug}` | 3001+ | One gateway per provisioned cloud customer                |

---

## Env file

Located at `/home/kayzo/app/.env`. Contains all secrets. Required variables:

```
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_CLOUD_PRICE_ID=
STRIPE_LOCAL_PRICE_ID=
ROUTER_PORT=9000
```

After editing `.env`, restart the router and any affected gateways:

```bash
sudo -u kayzo bash --login -c "
  export HOME=/home/kayzo
  export PATH=\"\$HOME/.fnm:\$PATH\"
  eval \"\$(fnm env --shell bash)\"
  pm2 restart kayzo-router --update-env
"
```

Gateway processes source `.env` automatically via their `start.sh` wrapper.

---

## Provisioning a customer

### Cloud customer (hosted on this VPS)

```bash
sudo bash /home/kayzo/app/scripts/provision-customer.sh \
  --name "Bob Smith" \
  --email bob@example.com \
  --slug bobsmith
```

Add `--free` to skip Stripe and set the account active immediately:

```bash
sudo bash /home/kayzo/app/scripts/provision-customer.sh \
  --name "Bob Smith" \
  --email bob@example.com \
  --slug bobsmith \
  --free
```

### Local customer (self-hosted gateway, Supabase record only)

```bash
sudo bash /home/kayzo/app/scripts/provision-customer.sh \
  --name "Bob Smith" \
  --email bob@example.com \
  --slug bobsmith-local \
  --local \
  --free
```

Once the local customer shares their gateway URL:

```bash
cd /home/kayzo/app
npx tsx scripts/set-gateway-url.ts --slug bobsmith-local --url https://kayzo.bob.example.com
```

### What provisioning creates

For a cloud customer the script:

1. Generates a UUID license key, temp password, and hook token
2. Finds the next available port (starting at 3001)
3. Creates `/home/kayzo/customers/{slug}/kayzo.json` with all plugin config
4. Creates `/home/kayzo/customers/{slug}/start.sh` — the PM2 wrapper that sources `.env` and sets `KAYZO_CONFIG`
5. Inserts a row in `customers` and creates a Supabase Auth user
6. Links the auth user ID on the customer record (used by router for JWT verification)
7. Adds a `{slug}.kayzo.app` Caddy entry and reloads Caddy
8. Starts `kayzo-{slug}` via PM2 and saves the process list

For a local customer it only does steps 1 and 5-6 (no directory, no PM2, no Caddy).

---

## Per-customer directory layout

```
/home/kayzo/customers/{slug}/
  kayzo.json          gateway config (plugins, model, workspace path, hooks)
  start.sh            PM2 wrapper — sources .env, sets KAYZO_CONFIG, execs gateway
  workspace/          agent memory and working files
    MEMORY.md         (created after first agent run)
    memory/           (subdirectory for individual memory files)
```

### kayzo.json structure

```json
{
  "gateway": { "mode": "local", "port": 3001, "bind": "loopback", "auth": { "token": "..." } },
  "agents": { "defaults": { "model": "anthropic/claude-sonnet-4-6", "workspace": "..." } },
  "plugins": {
    "entries": {
      "kayzo-license": { "enabled": true, "config": { "licenseKey": "...", "supabaseUrl": "...", ... } },
      "kayzo-sync":    { "enabled": true, "config": { "licenseKey": "...", "supabaseUrl": "...", ... } }
    }
  },
  "hooks": { "enabled": false, "token": "...", "path": "/webhook", "presets": ["gmail"], "gmail": { ... } }
}
```

---

## Plugins

### kayzo-license (`extensions/kayzo-license/`)

Runs on every gateway. On startup it validates the license key against Supabase, writes a `preferences-context.md` file into the workspace, and injects that file as system context before every agent turn. Every 60 seconds it checks for a preferences refresh flag file written by the router. Every 24 hours it re-validates the license. After each agent turn it fire-and-forgets a usage log to Supabase.

### kayzo-sync (`extensions/kayzo-sync/`)

On startup, if the workspace has no memory files, it calls the `restore-memory` Edge Function and writes any backed-up files to disk. Every 30 minutes it reads all memory markdown files from the workspace and upserts them to the `contractor_memory` table via the `backup-memory` Edge Function.

---

## Router (`extensions/kayzo-router/`)

Runs as `kayzo-router` on port 9000. Routes:

| Path                           | Auth                | Description                             |
| ------------------------------ | ------------------- | --------------------------------------- |
| `GET /health`                  | none                | Liveness probe                          |
| `WS /ws/:slug`                 | Supabase JWT        | WebSocket proxy to customer gateway     |
| `GET /api/preferences/:slug`   | Supabase JWT        | Read contractor preferences             |
| `PATCH /api/preferences/:slug` | Supabase JWT        | Write contractor preferences            |
| `* /api/:slug/*`               | none (rate-limited) | Gmail webhook proxy to customer gateway |

The router keeps a 60-second in-memory cache of `customers` records (slug → port + auth_user_id). JWT verification uses the `SUPABASE_JWT_SECRET` from `.env`.

When preferences are updated via PATCH, the router writes a flag file at `/tmp/kayzo-prefs-refresh-{license_key}` which the kayzo-license plugin polls every 60 seconds.

---

## Caddy (TLS / reverse proxy)

Config at `/etc/caddy/Caddyfile`. The main entry point:

```
api.kayzo.app {
  reverse_proxy localhost:9000
}
```

Each cloud customer also gets a direct-access subdomain added automatically during provisioning:

```
{slug}.kayzo.app {
  reverse_proxy localhost:{port}
}
```

Reload after editing:

```bash
systemctl reload caddy
```

---

## Supabase

### Tables

| Table                    | Description                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `customers`              | One row per customer. `slug`, `license_key`, `provisioned_port`, `auth_user_id`, `gateway_type`, `gateway_url`, `subscription_status` |
| `contractor_preferences` | One row per customer keyed by `license_key`. Autonomy settings for ordering, scheduling, email replies, flagging, bid markup.         |
| `contractor_memory`      | One row per customer. `memory_data` JSONB stores all markdown memory files. Written by the kayzo-sync plugin.                         |
| `usage_logs`             | One row per customer per month. `input_tokens` and `output_tokens` accumulate via upsert after each agent turn.                       |

### Edge Functions

| Function           | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| `validate-license` | Returns license validity, tier, status, token budget, overBudget flag     |
| `log-usage`        | Upserts token counts into `usage_logs` for current month                  |
| `get-preferences`  | Returns contractor preferences for a license key                          |
| `backup-memory`    | Upserts memory files into `contractor_memory`                             |
| `restore-memory`   | Returns memory files from `contractor_memory`                             |
| `stripe-webhook`   | Handles Stripe checkout and payment events, updates `subscription_status` |

Edge Functions cold-start on Supabase's free tier can take 15-30 seconds. The plugins handle this gracefully — they log a warning and continue without blocking the gateway.

---

## Skills

The construction skills live at `skills/kayzo/SKILL.md`. This file is loaded automatically by the OpenClaw skill system for every agent turn and contains:

- Construction industry context and persona
- Email handling instructions (how to triage, reply, flag, escalate)
- Ordering and scheduling autonomy rules (reads from preferences-context.md)
- Bid generation format

`skills/kayzo/PREFERENCES.md` is a template that the kayzo-license plugin renders into `preferences-context.md` in the customer workspace using that customer's actual preference values.

---

## Deploying updates

```bash
# 1. Pull latest on VPS
cd /home/kayzo/app && git pull

# 2. Rebuild (only needed if TypeScript source changed)
sudo -u kayzo bash --login -c "
  export HOME=/home/kayzo
  export PATH=\"\$HOME/.fnm:\$PATH\"
  eval \"\$(fnm env --shell bash)\"
  cd /home/kayzo/app && pnpm build 2>&1 | tail -5
"

# 3. Restart the router
sudo -u kayzo bash --login -c "
  export HOME=/home/kayzo
  export PATH=\"\$HOME/.fnm:\$PATH\"
  eval \"\$(fnm env --shell bash)\"
  pm2 restart kayzo-router --update-env
"

# 4. Restart customer gateways (if gateway code changed)
sudo -u kayzo bash --login -c "
  export HOME=/home/kayzo
  export PATH=\"\$HOME/.fnm:\$PATH\"
  eval \"\$(fnm env --shell bash)\"
  pm2 restart kayzo-testuser --update-env
"
```

---

## Tearing down a customer

```bash
sudo bash /home/kayzo/app/scripts/teardown-customer.sh --slug bobsmith
```

This stops and removes the PM2 process and sets `subscription_status=canceled` in Supabase. Add `--delete-dir` to also remove `/home/kayzo/customers/bobsmith/`.

---

## Admin scripts

All scripts run from `/home/kayzo/app` or locally with `npx tsx`:

| Script                                | Description                               |
| ------------------------------------- | ----------------------------------------- |
| `scripts/provision-customer.sh`       | Provision a new cloud or local customer   |
| `scripts/teardown-customer.sh`        | Remove a customer                         |
| `scripts/provision-local-customer.sh` | Supabase-only local customer (no VPS)     |
| `scripts/set-gateway-url.ts`          | Set gateway URL for a local customer      |
| `scripts/list-customers.ts`           | Print all customers with usage and status |

---

## Integration test results (2026-04-14)

Verified end-to-end on the live VPS after full backend build:

| Test                                                    | Result |
| ------------------------------------------------------- | ------ |
| Cloud customer provisioned via script                   | Pass   |
| Local customer provisioned via script                   | Pass   |
| Gateway starts and binds to assigned port               | Pass   |
| Router health endpoint (`GET /health`)                  | Pass   |
| Router webhook proxy (`/api/testuser/health` → gateway) | Pass   |
| Public HTTPS via Caddy + Cloudflare (`api.kayzo.app`)   | Pass   |
| Agent responds to a message                             | Pass   |
| License validation edge function                        | Pass   |
| Usage tokens logged to Supabase after agent turn        | Pass   |
| Memory backup written to Supabase                       | Pass   |
| Memory restore returns backed-up data                   | Pass   |

### Known behaviors (not bugs)

- **Supabase cold-start timeouts at gateway startup**: Edge Functions on the free tier can take 15-30 seconds to cold-start. The plugins log a warning (`startup check failed: The operation was aborted due to timeout`) and continue. All calls succeed once functions are warm. This does not affect agent functionality.
- **Bonjour/mDNS warnings in logs**: The gateway tries to advertise itself on the local network via mDNS. On a headless VPS this will repeatedly fail with `restarting advertiser`. These are cosmetic and do not affect operation.

---

## Bugs fixed during build

These were found and fixed during the initial build. Documented here for context.

| Bug                                                                 | Fix                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provision-customer.sh` silently exits after generating credentials | `gen_password()` used `tr \| head -c 16` under `set -o pipefail`; `tr` exits 141 (SIGPIPE) when `head` closes the pipe. Fixed: added `\|\| true`.                                           |
| Gateway subcommand wrong                                            | Script used `kayzo.mjs gateway` instead of `kayzo.mjs gateway run`.                                                                                                                         |
| PM2 env var not passed to gateway                                   | `KAYZO_CONFIG=value pm2 start` sets the env on the PM2 client, not the daemon-forked process. Fixed: per-customer `start.sh` wrapper that exports the variable before exec.                 |
| Gateway missing `ANTHROPIC_API_KEY`                                 | `start.sh` didn't source `.env`. Fixed: `set -a; source /home/kayzo/app/.env; set +a` added to wrapper.                                                                                     |
| Router webhook proxy path wrong                                     | Express strips the mount prefix from `req.url`; the manual `.replace` was double-stripping. Fixed: use `req.originalUrl` instead.                                                           |
| Prompt 2 changes never committed                                    | `src/config/paths.ts`, `src/daemon/constants.ts`, `src/entry.ts`, `src/gateway/server-runtime-config.ts`, and UI files were modified locally but never staged. Fixed: committed and pushed. |
