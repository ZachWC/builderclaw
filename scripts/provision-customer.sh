#!/usr/bin/env bash
# Kayzo -- Customer Provisioning Script
#
# Usage:
#   sudo bash scripts/provision-customer.sh --name "Acme Construction" --email contractor@acme.com --slug acme
#   sudo bash scripts/provision-customer.sh --name "Bob" --email bob@example.com --slug bob --free
#   bash scripts/provision-customer.sh --name "Local Bob" --email bob@example.com --slug bob-local --local
#
# --free    sets subscription_status=active and free_account=true (no Stripe required)
# --local   creates only the Supabase record; no port, no directory, no PM2, no Caddy

set -euo pipefail

# ── Paths / constants ─────────────────────────────────────────────────────────

APP_DIR="/home/kayzo/app"
CUSTOMERS_DIR="/home/kayzo/customers"
ENV_FILE="${APP_DIR}/.env"
CADDYFILE="/etc/caddy/Caddyfile"
PORT_START=3001

# ── Load env ──────────────────────────────────────────────────────────────────

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a; source "${ENV_FILE}"; set +a
fi

SUPABASE_URL="${SUPABASE_URL:?Set SUPABASE_URL in ${ENV_FILE}}"
SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:?Set SUPABASE_SERVICE_ROLE_KEY in ${ENV_FILE}}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"

# ── Arg parsing ───────────────────────────────────────────────────────────────

NAME=""
EMAIL=""
SLUG=""
FREE=false
LOCAL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)  NAME="$2";  shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --slug)  SLUG="$2";  shift 2 ;;
    --free)  FREE=true;  shift   ;;
    --local) LOCAL=true; shift   ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# ── Validation ────────────────────────────────────────────────────────────────

[[ -n "${NAME}"  ]] || { echo "Error: --name is required";  exit 1; }
[[ -n "${EMAIL}" ]] || { echo "Error: --email is required"; exit 1; }
[[ -n "${SLUG}"  ]] || { echo "Error: --slug is required";  exit 1; }

if ! [[ "${SLUG}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "Error: --slug must be lowercase alphanumeric (hyphens allowed between words)"
  exit 1
fi

if [[ "${LOCAL}" == false ]] && [[ -d "${CUSTOMERS_DIR}/${SLUG}" ]]; then
  echo "Error: customer directory ${CUSTOMERS_DIR}/${SLUG} already exists"
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

info() { echo ""; echo "==> $*"; }
ok()   { echo "    [ok] $*"; }

# Generate a UUID v4
gen_uuid() {
  python3 -c "import uuid; print(uuid.uuid4())"
}

# Generate a random 16-char alphanumeric password
# Use || true to suppress SIGPIPE exit (141) from tr when head closes the pipe early;
# set -o pipefail would otherwise abort the script.
gen_password() {
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 16 || true
}

# Supabase REST request (returns response body)
supa_rest() {
  local method="$1" path="$2" body="${3:-}"
  curl -sf -X "${method}" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    ${body:+-d "${body}"} \
    "${SUPABASE_URL}/rest/v1/${path}"
}

# Supabase Auth admin API
supa_auth() {
  local method="$1" path="$2" body="${3:-}"
  curl -sf -X "${method}" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    ${body:+-d "${body}"} \
    "${SUPABASE_URL}/auth/v1/admin/${path}"
}

# Find next available port not already in customers table or in use
find_next_port() {
  local port=${PORT_START}
  # Get all provisioned ports from Supabase
  local used_ports
  used_ports=$(supa_rest GET "customers?select=provisioned_port&provisioned_port=not.is.null" \
    | python3 -c "import sys,json; print('\n'.join(str(r['provisioned_port']) for r in json.load(sys.stdin)))" 2>/dev/null || true)

  while true; do
    # Check not in DB
    if echo "${used_ports}" | grep -qx "${port}"; then
      ((port++)); continue
    fi
    # Check not in use on this machine
    if ! ss -ltn 2>/dev/null | grep -q ":${port} " && \
       ! lsof -i ":${port}" &>/dev/null 2>&1; then
      echo "${port}"
      return
    fi
    ((port++))
  done
}

# ── Generate credentials ──────────────────────────────────────────────────────

info "Generating credentials"
LICENSE_KEY=$(gen_uuid)
TEMP_PASSWORD=$(gen_password)
HOOK_TOKEN=$(gen_password)
ok "License key: ${LICENSE_KEY}"

# ── Cloud-only: find port, create directory, write config ─────────────────────

PORT=""
if [[ "${LOCAL}" == false ]]; then
  info "Finding next available port"
  PORT=$(find_next_port)
  ok "Port: ${PORT}"

  info "Creating customer directory"
  mkdir -p "${CUSTOMERS_DIR}/${SLUG}"
  ok "${CUSTOMERS_DIR}/${SLUG}"

  info "Writing kayzo.json"
  cat > "${CUSTOMERS_DIR}/${SLUG}/kayzo.json" << CFGEOF
{
  "gateway": {
    "mode": "local",
    "port": ${PORT},
    "bind": "loopback",
    "auth": {
      "token": "$(gen_password)"
    },
    "controlUi": {
      "enabled": false
    }
  },
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4-6",
      "workspace": "${CUSTOMERS_DIR}/${SLUG}/workspace"
    }
  },
  "plugins": {
    "entries": {
      "kayzo-license": {
        "enabled": true,
        "config": {
          "licenseKey": "${LICENSE_KEY}",
          "supabaseUrl": "${SUPABASE_URL}",
          "supabaseAnonKey": "${SUPABASE_ANON_KEY}",
          "customerSlug": "${SLUG}"
        }
      },
      "kayzo-sync": {
        "enabled": true,
        "config": {
          "licenseKey": "${LICENSE_KEY}",
          "supabaseUrl": "${SUPABASE_URL}",
          "supabaseAnonKey": "${SUPABASE_ANON_KEY}",
          "backupIntervalMinutes": 30
        }
      }
    }
  },
  "hooks": {
    "enabled": false,
    "token": "${HOOK_TOKEN}",
    "path": "/webhook",
    "presets": ["gmail"],
    "gmail": {
      "account": "",
      "topic": "",
      "hookUrl": "https://api.kayzo.app/api/${SLUG}/webhook/gmail",
      "pushToken": "${HOOK_TOKEN}",
      "renewEveryMinutes": 720,
      "includeBody": true,
      "label": "INBOX"
    }
  }
}
CFGEOF
  chmod 600 "${CUSTOMERS_DIR}/${SLUG}/kayzo.json"
  chown -R kayzo:kayzo "${CUSTOMERS_DIR}/${SLUG}"
  ok "kayzo.json written"
fi

# ── Supabase: insert customer record ─────────────────────────────────────────

info "Creating Supabase customer record"

SUBSCRIPTION_STATUS="trialing"
FREE_ACCOUNT="false"
if [[ "${FREE}" == true ]]; then
  SUBSCRIPTION_STATUS="active"
  FREE_ACCOUNT="true"
fi

GATEWAY_TYPE="cloud"
PROVISIONED_PORT_JSON="\"provisioned_port\": ${PORT}"
if [[ "${LOCAL}" == true ]]; then
  GATEWAY_TYPE="local"
  PROVISIONED_PORT_JSON="\"provisioned_port\": null"
fi

CUSTOMER_RESPONSE=$(supa_rest POST "customers" "{
  \"email\": \"${EMAIL}\",
  \"name\": \"${NAME}\",
  \"slug\": \"${SLUG}\",
  \"license_key\": \"${LICENSE_KEY}\",
  ${PROVISIONED_PORT_JSON},
  \"subscription_status\": \"${SUBSCRIPTION_STATUS}\",
  \"free_account\": ${FREE_ACCOUNT},
  \"gateway_type\": \"${GATEWAY_TYPE}\",
  \"gateway_url\": null
}")

ok "Customer record created"

# The trigger auto-creates contractor_preferences — verify it
sleep 1
PREFS_CHECK=$(supa_rest GET "contractor_preferences?license_key=eq.${LICENSE_KEY}&select=id" || echo "[]")
if echo "${PREFS_CHECK}" | python3 -c "import sys,json; data=json.load(sys.stdin); exit(0 if len(data)>0 else 1)" 2>/dev/null; then
  ok "contractor_preferences row auto-created by trigger"
else
  echo "  [warn] contractor_preferences row not found -- inserting manually"
  supa_rest POST "contractor_preferences" "{\"license_key\": \"${LICENSE_KEY}\"}" > /dev/null
fi

# ── Supabase: create auth user ────────────────────────────────────────────────

info "Creating Supabase Auth user"
AUTH_RESPONSE=$(supa_auth POST "users" "{
  \"email\": \"${EMAIL}\",
  \"email_confirm\": true,
  \"password\": \"${TEMP_PASSWORD}\"
}")

AUTH_USER_ID=$(echo "${AUTH_RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
if [[ -n "${AUTH_USER_ID}" ]]; then
  # Store auth_user_id on the customer record for router JWT verification
  supa_rest PATCH "customers?license_key=eq.${LICENSE_KEY}" \
    "{\"auth_user_id\": \"${AUTH_USER_ID}\"}" > /dev/null
  ok "Auth user created (id: ${AUTH_USER_ID})"
else
  echo "  [warn] Could not extract auth user id from response -- auth_user_id not stored"
fi

# ── Cloud-only: Caddy + PM2 ───────────────────────────────────────────────────

if [[ "${LOCAL}" == false ]]; then
  # Caddy: add direct-access fallback entry
  info "Adding Caddy entry for direct access fallback"
  if [[ -f "${CADDYFILE}" ]] && ! grep -q "${SLUG}.kayzo.app" "${CADDYFILE}" 2>/dev/null; then
    cat >> "${CADDYFILE}" << CADDYEOF

${SLUG}.kayzo.app {
  reverse_proxy localhost:${PORT}
}
CADDYEOF
    systemctl reload caddy 2>/dev/null && ok "Caddy reloaded" || echo "  [warn] Could not reload Caddy (not running or no systemd)"
  else
    ok "Caddy entry already present or Caddyfile not found -- skipping"
  fi

  # PM2: start gateway process
  info "Starting gateway with PM2"
  sudo -u kayzo bash --login -c "
    export HOME=/home/kayzo
    export PATH=\"\$HOME/.fnm:\$PATH\"
    eval \"\$(fnm env --shell bash)\"
    KAYZO_CONFIG=${CUSTOMERS_DIR}/${SLUG}/kayzo.json \
      pm2 start ${APP_DIR}/kayzo.mjs \
      --name 'kayzo-${SLUG}' \
      -- gateway
    pm2 save
  "

  # Wait and verify
  info "Verifying gateway process"
  sleep 5
  if sudo -u kayzo bash --login -c "
    export HOME=/home/kayzo
    export PATH=\"\$HOME/.fnm:\$PATH\"
    eval \"\$(fnm env --shell bash)\"
    pm2 list | grep -q 'kayzo-${SLUG}'
  "; then
    ok "Gateway process kayzo-${SLUG} is running"
  else
    echo "  [warn] Gateway process not found in pm2 list -- check logs with: pm2 logs kayzo-${SLUG}"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                   Customer provisioned                       ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  %-18s %-40s ║\n" "Name:"     "${NAME}"
printf "║  %-18s %-40s ║\n" "Email:"    "${EMAIL}"
printf "║  %-18s %-40s ║\n" "Slug:"     "${SLUG}"
printf "║  %-18s %-40s ║\n" "Login:"    "https://app.kayzo.app"
printf "║  %-18s %-40s ║\n" "Password:" "Reset email sent via Supabase"
printf "║  %-18s %-40s ║\n" "License:"  "${LICENSE_KEY}"
if [[ "${LOCAL}" == false ]]; then
printf "║  %-18s %-40s ║\n" "Port:"     "${PORT}"
printf "║  %-18s %-40s ║\n" "Type:"     "cloud (PM2: kayzo-${SLUG})"
else
printf "║  %-18s %-40s ║\n" "Type:"     "local (no server process)"
fi
if [[ "${FREE}" == true ]]; then
printf "║  %-18s %-40s ║\n" "Plan:"     "free account (active)"
fi
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
