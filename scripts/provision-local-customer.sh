#!/usr/bin/env bash
# Kayzo -- Provision Local Customer
#
# Creates a Supabase record only (no VPS gateway, no PM2, no Caddy).
# The contractor will run the Kayzo gateway on their own machine.
#
# Usage:
#   bash scripts/provision-local-customer.sh --name "Bob Builder" --email bob@example.com --slug bob-local
#   bash scripts/provision-local-customer.sh --name "Bob Builder" --email bob@example.com --slug bob-local --free

set -euo pipefail

APP_DIR="/home/kayzo/app"
ENV_FILE="${APP_DIR}/.env"

# Try loading .env if it exists (may not be present on dev machines)
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a; source "${ENV_FILE}"; set +a
fi

# Also try repo-local .env for development use
REPO_ENV="$(cd "$(dirname "$0")/.." && pwd)/.env"
if [[ -f "${REPO_ENV}" ]]; then
  # shellcheck disable=SC1090
  set -a; source "${REPO_ENV}"; set +a
fi

SUPABASE_URL="${SUPABASE_URL:?Set SUPABASE_URL in ${ENV_FILE}}"
SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:?Set SUPABASE_SERVICE_ROLE_KEY in ${ENV_FILE}}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"

# ── Arg parsing ───────────────────────────────────────────────────────────────

NAME=""
EMAIL=""
SLUG=""
FREE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)  NAME="$2";  shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --slug)  SLUG="$2";  shift 2 ;;
    --free)  FREE=true;  shift   ;;
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

# ── Helpers ───────────────────────────────────────────────────────────────────

info() { echo ""; echo "==> $*"; }
ok()   { echo "    [ok] $*"; }

gen_uuid() {
  python3 -c "import uuid; print(uuid.uuid4())"
}

gen_password() {
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 16
}

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

supa_auth() {
  local method="$1" path="$2" body="${3:-}"
  curl -sf -X "${method}" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    ${body:+-d "${body}"} \
    "${SUPABASE_URL}/auth/v1/admin/${path}"
}

# ── Generate credentials ──────────────────────────────────────────────────────

info "Generating credentials"
LICENSE_KEY=$(gen_uuid)
TEMP_PASSWORD=$(gen_password)
ok "License key: ${LICENSE_KEY}"

# ── Supabase: insert customer record ─────────────────────────────────────────

info "Creating Supabase customer record"

SUBSCRIPTION_STATUS="trialing"
FREE_ACCOUNT="false"
if [[ "${FREE}" == true ]]; then
  SUBSCRIPTION_STATUS="active"
  FREE_ACCOUNT="true"
fi

supa_rest POST "customers" "{
  \"email\": \"${EMAIL}\",
  \"name\": \"${NAME}\",
  \"slug\": \"${SLUG}\",
  \"license_key\": \"${LICENSE_KEY}\",
  \"provisioned_port\": null,
  \"subscription_status\": \"${SUBSCRIPTION_STATUS}\",
  \"free_account\": ${FREE_ACCOUNT},
  \"gateway_type\": \"local\",
  \"gateway_url\": null
}" > /dev/null

ok "Customer record created"

# Verify contractor_preferences trigger
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
  supa_rest PATCH "customers?license_key=eq.${LICENSE_KEY}" \
    "{\"auth_user_id\": \"${AUTH_USER_ID}\"}" > /dev/null
  ok "Auth user created (id: ${AUTH_USER_ID})"
else
  echo "  [warn] Could not extract auth user id -- auth_user_id not stored"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                Local Customer Provisioned                    ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  %-18s %-40s ║\n" "Name:"     "${NAME}"
printf "║  %-18s %-40s ║\n" "Email:"    "${EMAIL}"
printf "║  %-18s %-40s ║\n" "Slug:"     "${SLUG}"
printf "║  %-18s %-40s ║\n" "Type:"     "local (customer-hosted)"
printf "║  %-18s %-40s ║\n" "License:"  "${LICENSE_KEY}"
if [[ "${FREE}" == true ]]; then
printf "║  %-18s %-40s ║\n" "Plan:"     "free account (active)"
else
printf "║  %-18s %-40s ║\n" "Plan:"     "trialing (set Stripe payment to activate)"
fi
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Next steps for the contractor:                              ║"
echo "║  1. Install Kayzo on their machine                           ║"
echo "║  2. Add the license key to their kayzo.json plugin config    ║"
echo "║  3. Run: bash scripts/set-gateway-url.ts --slug ${SLUG}"
printf "║     %-57s ║\n" "   once they share their gateway URL"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
