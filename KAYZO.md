# Kayzo -- Modified Upstream Files

This file tracks every file modified from the upstream OpenClaw fork.
See kayzo-mvp-spec.md for the full build specification.

## Prompt 2 -- Rename, config override, disable WebChat

| File                                         | Change                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`                               | name → `kayzo`, bin → `kayzo`/`kayzo.mjs`, files → `kayzo.mjs`, exports `./cli-entry` → `kayzo.mjs`, scripts `openclaw`/`openclaw:rpc` → `kayzo`/`kayzo:rpc` |
| `kayzo.mjs`                                  | New file (copy of `openclaw.mjs`); this is the Kayzo CLI entry point                                                                                         |
| `src/config/paths.ts`                        | `NEW_STATE_DIRNAME` → `.kayzo`, `CONFIG_FILENAME` → `kayzo.json`, all `OPENCLAW_CONFIG_PATH` env var checks → `KAYZO_CONFIG`                                 |
| `src/daemon/constants.ts`                    | All service labels, names, markers, and description strings updated from `openclaw`/`OpenClaw` → `kayzo`/`Kayzo`                                             |
| `scripts/systemd/kayzo-auth-monitor.service` | New file replacing `openclaw-auth-monitor.service` with Kayzo paths and descriptions                                                                         |
| `src/gateway/server-runtime-config.ts`       | `controlUiEnabled` default changed from `true` → `false` (WebChat/Control UI disabled by default)                                                            |
| `src/entry.ts`                               | Added `kayzo.mjs` to `ENTRY_WRAPPER_PAIRS` so `isMainModule` check passes when running via the renamed binary                                                |
| `ui/src/ui/components/dashboard-header.ts`   | User-visible "OpenClaw" text → "Kayzo"                                                                                                                       |
| `ui/src/ui/views/login-gate.ts`              | User-visible "OpenClaw" text and alt text → "Kayzo"                                                                                                          |
| `ui/src/ui/app-render.ts`                    | User-visible "OpenClaw" alt text and sidebar title → "Kayzo"                                                                                                 |
| `ui/src/ui/views/chat.ts`                    | User-visible "OpenClaw" alt text → "Kayzo"                                                                                                                   |

## Prompt 11 -- Memory backup plugin

| File                                         | Change                                                                                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/kayzo-sync/openclaw.plugin.json` | New plugin manifest. Config schema: `licenseKey`, `supabaseUrl`, `supabaseAnonKey`, `backupIntervalMinutes`.                                                                                        |
| `extensions/kayzo-sync/package.json`         | New workspace package. No runtime deps — uses plugin-sdk only.                                                                                                                                      |
| `extensions/kayzo-sync/api.ts`               | Local barrel re-exporting `definePluginEntry` and types from `openclaw/plugin-sdk/core`.                                                                                                            |
| `extensions/kayzo-sync/index.ts`             | Plugin implementation: `gateway_start` (check if memory empty → restore from Supabase), `registerService` (30-min backup timer, fire-and-forget). Collects `MEMORY.md`, `memory.md`, `memory/*.md`. |
| `supabase/functions/backup-memory/index.ts`  | New Edge Function. POST `{ license_key, memory_data }` → upserts `contractor_memory`.                                                                                                               |
| `supabase/functions/restore-memory/index.ts` | New Edge Function. POST `{ license_key }` → returns `memory_data` or null.                                                                                                                          |
| `scripts/provision-customer.sh`              | Added `kayzo-sync` plugin entry to kayzo.json template.                                                                                                                                             |

## Prompt 10 -- Gmail integration

| File                            | Change                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/provision-customer.sh` | Added Gmail hooks block to kayzo.json template: `hooks.enabled=false`, `hooks.path="/webhook"`, `hooks.presets=["gmail"]`, `hooks.gmail.hookUrl=https://api.kayzo.ai/api/{slug}/webhook/gmail`. Generates `HOOK_TOKEN` per customer. |
| `docs/gmail-setup.md`           | New file. Plain-language Gmail setup guide for non-technical contractors. Covers Google Cloud project, Pub/Sub topic + push subscription, Gmail API credentials, kayzo.json config, and first-time OAuth authorization.              |

**Gmail flow:**

- Pub/Sub pushes to `https://api.kayzo.ai/api/{slug}/webhook/gmail`
- Router strips `/api/{slug}` → gateway receives `/webhook/gmail`
- Gateway matches via `hooks.path="/webhook"` + `presets=["gmail"]`
- Hook mapping triggers isolated agent turn with email content
- SKILL.md (includes EMAIL.md content) loaded automatically for all agent runs

## Prompt 9 -- Stripe integration and admin scripts

| File                                         | Change                                                                                                                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/functions/stripe-webhook/index.ts` | `PRICE_TIER_MAP` now reads from `STRIPE_CLOUD_PRICE_ID`/`STRIPE_LOCAL_PRICE_ID` env vars. Added `invoice.payment_failed` handler → sets `subscription_status=past_due`.                                                      |
| `scripts/stripe-setup.md`                    | New file. Step-by-step Stripe dashboard checklist: create products/prices, payment links, webhook endpoint, set Supabase secrets, update VPS `.env`, verify.                                                                 |
| `scripts/list-customers.ts`                  | New file. Queries customers + usage_logs for current month. Prints table with name, slug, type ([CLOUD]/[LOCAL]/[LOCAL - URL PENDING]/[FREE]), status, tokens used, created date. Usage: `npx tsx scripts/list-customers.ts` |
| `scripts/provision-local-customer.sh`        | New file. Args: `--name`, `--email`, `--slug`, `--free`. Creates Supabase customer record with `gateway_type=local`, auth user, and contractor_preferences row. No VPS/PM2/Caddy.                                            |
| `scripts/set-gateway-url.ts`                 | New file. Args: `--slug`, `--url`. Updates `customers.gateway_url` in Supabase for local customers once they share their self-hosted gateway URL. Usage: `npx tsx scripts/set-gateway-url.ts --slug bob --url https://...`   |

## Prompt 8 -- Customer provisioning

| File                            | Change                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/provision-customer.sh` | New file. Args: `--name`, `--email`, `--slug`, `--free`, `--local`. Cloud flow: validates slug, finds next available port, writes `kayzo.json`, inserts Supabase customer + auth user, links `auth_user_id`, adds Caddy entry, starts PM2 gateway, verifies process. Local flow: Supabase record only, no port/directory/PM2/Caddy. |
| `scripts/teardown-customer.sh`  | New file. Stops and removes PM2 process, sets Supabase `subscription_status=canceled`, optionally deletes customer directory.                                                                                                                                                                                                       |

## Prompt 7 -- License, usage, and preferences plugin

| File                                            | Change                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/kayzo-license/openclaw.plugin.json` | New plugin manifest. Config schema: `licenseKey`, `supabaseUrl`, `supabaseAnonKey`, `customerSlug`.                                                                                                                                                                                                               |
| `extensions/kayzo-license/package.json`         | New workspace package. No runtime deps — uses plugin-sdk only.                                                                                                                                                                                                                                                    |
| `extensions/kayzo-license/api.ts`               | Local barrel re-exporting `definePluginEntry` and types from `openclaw/plugin-sdk/core`.                                                                                                                                                                                                                          |
| `extensions/kayzo-license/index.ts`             | Plugin implementation: `gateway_start` (validate + prefs + write derived files), `before_agent_start` (inject `preferences-context.md` as `appendSystemContext`), `llm_output` (accumulate tokens per run), `agent_end` (fire-and-forget `log-usage`), `registerService` (60s prefs watcher + 24h re-validation). |

## Prompt 6 -- Gateway API router

| File                                       | Change                                                                                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/kayzo-router/package.json`     | New package. Runtime deps: express, ws, jose, @supabase/supabase-js, express-rate-limit, dotenv.                                                                                                          |
| `extensions/kayzo-router/index.mjs`        | New file. Express + WebSocket router: `/health`, `/ws/:slug` (JWT-authed WS proxy), `/api/preferences/:slug` (GET/PATCH, JWT-authed), `/api/:slug/*` (unauthenticated, rate-limited Gmail webhook proxy). |
| `router.mjs`                               | New file. Thin PM2 entry point — imports extensions/kayzo-router/index.mjs.                                                                                                                               |
| `supabase/migrations/002_auth_user_id.sql` | Adds `auth_user_id uuid` column to `customers` + indexes on `slug` and `auth_user_id`.                                                                                                                    |

## Prompt 5 -- VPS server setup

| File                      | Change                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/setup-server.sh` | New file. Idempotent Ubuntu 24 setup: Node 24 via fnm, pnpm, PM2, Caddy (apt), kayzo user, repo clone + build, .env template, UFW 22/80/443, PM2 systemd startup. |

## Prompt 3 -- Construction skills

| File                          | Change                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/kayzo/SKILL.md`       | New file. Combined SKILL + EMAIL + ONBOARDING content. Loaded by OpenClaw skill system.                                                           |
| `skills/kayzo/PREFERENCES.md` | New file. Template read by `extensions/kayzo-license/` plugin to generate resolved `preferences-context.md`. Not loaded by skill system directly. |
