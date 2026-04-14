#!/usr/bin/env bash
# Kayzo -- Customer Teardown Script
#
# Usage:
#   sudo bash scripts/teardown-customer.sh --slug acme

set -euo pipefail

APP_DIR="/home/kayzo/app"
CUSTOMERS_DIR="/home/kayzo/customers"
ENV_FILE="${APP_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a; source "${ENV_FILE}"; set +a
fi

SUPABASE_URL="${SUPABASE_URL:?Set SUPABASE_URL in ${ENV_FILE}}"
SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:?Set SUPABASE_SERVICE_ROLE_KEY in ${ENV_FILE}}"

# ── Arg parsing ───────────────────────────────────────────────────────────────

SLUG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

[[ -n "${SLUG}" ]] || { echo "Error: --slug is required"; exit 1; }

# ── Confirm ───────────────────────────────────────────────────────────────────

echo ""
echo "  WARNING: This will stop and remove the gateway for customer: ${SLUG}"
echo "  Supabase subscription_status will be set to 'canceled'."
echo ""
read -r -p "  Type the slug to confirm: " CONFIRM

if [[ "${CONFIRM}" != "${SLUG}" ]]; then
  echo "Aborted."
  exit 1
fi

# ── Stop and remove PM2 process ───────────────────────────────────────────────

echo ""
echo "==> Stopping PM2 process kayzo-${SLUG}"
sudo -u kayzo bash --login -c "
  export HOME=/home/kayzo
  export PATH=\"\$HOME/.fnm:\$PATH\"
  eval \"\$(fnm env --shell bash)\"
  if pm2 list | grep -q 'kayzo-${SLUG}'; then
    pm2 stop 'kayzo-${SLUG}' || true
    pm2 delete 'kayzo-${SLUG}' || true
    pm2 save
    echo '    [ok] PM2 process stopped and removed'
  else
    echo '    [skip] PM2 process kayzo-${SLUG} not found'
  fi
" || echo "    [warn] Could not manage PM2 (not installed or not running as kayzo user)"

# ── Update Supabase ───────────────────────────────────────────────────────────

echo ""
echo "==> Updating Supabase subscription_status to canceled"
curl -sf -X PATCH \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -d '{"subscription_status":"canceled"}' \
  "${SUPABASE_URL}/rest/v1/customers?slug=eq.${SLUG}" \
  && echo "    [ok] Subscription status set to canceled" \
  || echo "    [warn] Supabase update failed -- update manually"

# ── Optionally delete customer directory ─────────────────────────────────────

CUSTOMER_DIR="${CUSTOMERS_DIR}/${SLUG}"
if [[ -d "${CUSTOMER_DIR}" ]]; then
  echo ""
  read -r -p "  Delete customer directory ${CUSTOMER_DIR}? [y/N]: " DELETE_DIR
  if [[ "${DELETE_DIR}" =~ ^[Yy]$ ]]; then
    rm -rf "${CUSTOMER_DIR}"
    echo "    [ok] Directory deleted"
  else
    echo "    [skip] Directory kept at ${CUSTOMER_DIR}"
  fi
fi

echo ""
echo "  Teardown complete for ${SLUG}."
echo ""
