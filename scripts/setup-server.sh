#!/usr/bin/env bash
# Kayzo -- VPS Server Setup
# Tested on Ubuntu 24.04 LTS
#
# DNS records to create BEFORE running this script:
#   A record: api.kayzo.ai -> [your VPS IP]
#
# Usage (run as root):
#   bash setup-server.sh
#
# This script is idempotent -- safe to run multiple times.

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────

REPO_URL="https://github.com/ZachWC/builderclaw.git"
KAYZO_USER="kayzo"
KAYZO_HOME="/home/${KAYZO_USER}"
APP_DIR="${KAYZO_HOME}/app"
CUSTOMERS_DIR="${KAYZO_HOME}/customers"
NODE_VERSION="24"
CADDY_EMAIL="admin@kayzo.app"
CADDY_DOMAIN="api.kayzo.app"
ROUTER_PORT="9000"

# ── Helpers ───────────────────────────────────────────────────────────────────

info()  { echo ""; echo "==> $*"; }
ok()    { echo "    [ok] $*"; }

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "Error: must run as root (sudo bash $0)"
    exit 1
  fi
}

# ── 1. System packages ────────────────────────────────────────────────────────

info "Updating apt and installing base packages"
apt-get update -qq
apt-get install -y -qq \
  curl git unzip build-essential ufw debian-keyring debian-archive-keyring apt-transport-https
ok "Base packages installed"

# ── 2. Caddy (official apt repo, not snap) ────────────────────────────────────

info "Installing Caddy"
if ! command -v caddy &>/dev/null; then
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
  ok "Caddy installed"
else
  ok "Caddy already installed ($(caddy version))"
fi

# ── 3. kayzo system user ──────────────────────────────────────────────────────

info "Creating kayzo user"
if ! id "${KAYZO_USER}" &>/dev/null; then
  useradd --system --create-home --home-dir "${KAYZO_HOME}" --shell /bin/bash "${KAYZO_USER}"
  ok "User ${KAYZO_USER} created"
else
  ok "User ${KAYZO_USER} already exists"
fi

mkdir -p "${APP_DIR}" "${CUSTOMERS_DIR}"
chown -R "${KAYZO_USER}:${KAYZO_USER}" "${KAYZO_HOME}"
ok "Directories: ${APP_DIR}  ${CUSTOMERS_DIR}"

# ── 4. Node 24 via fnm (installed for kayzo user) ─────────────────────────────

info "Installing Node ${NODE_VERSION} via fnm for ${KAYZO_USER}"
sudo -u "${KAYZO_USER}" bash -c '
  export HOME='"${KAYZO_HOME}"'
  if ! command -v fnm &>/dev/null 2>&1; then
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir "$HOME/.fnm" --skip-shell
  fi

  export PATH="$HOME/.fnm:$PATH"
  eval "$(fnm env --shell bash)"
  fnm install '"${NODE_VERSION}"' --lts 2>/dev/null || fnm install '"${NODE_VERSION}"'
  fnm default '"${NODE_VERSION}"'
'

# Add fnm init to kayzo bash profile so subshells pick it up
PROFILE="${KAYZO_HOME}/.bashrc"
if ! grep -q 'fnm env' "${PROFILE}" 2>/dev/null; then
  cat >> "${PROFILE}" <<'FNMEOF'

# fnm
export PATH="$HOME/.fnm:$PATH"
eval "$(fnm env --shell bash)"
FNMEOF
fi
ok "Node ${NODE_VERSION} installed for ${KAYZO_USER}"

# ── 5. pnpm and PM2 ──────────────────────────────────────────────────────────

info "Installing pnpm and PM2 globally for ${KAYZO_USER}"
sudo -u "${KAYZO_USER}" bash --login -c '
  export HOME='"${KAYZO_HOME}"'
  export PATH="$HOME/.fnm:$PATH"
  eval "$(fnm env --shell bash)"

  if ! command -v pnpm &>/dev/null; then
    npm install -g pnpm
  fi
  if ! command -v pm2 &>/dev/null; then
    npm install -g pm2
  fi
'
ok "pnpm and PM2 installed"

# ── 6. Clone / update repo ────────────────────────────────────────────────────

info "Cloning Kayzo repo to ${APP_DIR}"
if [[ ! -d "${APP_DIR}/.git" ]]; then
  sudo -u "${KAYZO_USER}" git clone "${REPO_URL}" "${APP_DIR}"
  ok "Repo cloned"
else
  sudo -u "${KAYZO_USER}" git -C "${APP_DIR}" pull --rebase --autostash
  ok "Repo updated"
fi

# ── 7. pnpm install && pnpm build ─────────────────────────────────────────────

info "Running pnpm install && pnpm build in ${APP_DIR}"
sudo -u "${KAYZO_USER}" bash --login -c "
  export HOME=${KAYZO_HOME}
  export PATH=\"\$HOME/.fnm:\$PATH\"
  eval \"\$(fnm env --shell bash)\"
  cd ${APP_DIR}
  pnpm install --frozen-lockfile
  pnpm build
"
ok "Build complete"

# ── 8. .env file ─────────────────────────────────────────────────────────────

info "Writing ${APP_DIR}/.env"
ENV_FILE="${APP_DIR}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  cat > "${ENV_FILE}" <<'ENVEOF'
# Kayzo environment variables
# Fill in all values before starting the gateway or router

ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...
ENVEOF
  chown "${KAYZO_USER}:${KAYZO_USER}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  ok ".env created (fill in values before starting services)"
else
  ok ".env already exists -- not overwritten"
fi

# ── 9. PM2 startup for kayzo user ─────────────────────────────────────────────

info "Setting up PM2 systemd startup for ${KAYZO_USER}"
# pm2 startup prints a command that must be run as root
STARTUP_CMD=$(sudo -u "${KAYZO_USER}" bash --login -c "
  export HOME=${KAYZO_HOME}
  export PATH=\"\$HOME/.fnm:\$PATH\"
  eval \"\$(fnm env --shell bash)\"
  pm2 startup systemd -u ${KAYZO_USER} --hp ${KAYZO_HOME} 2>/dev/null | grep '^sudo'
" || true)

if [[ -n "${STARTUP_CMD}" ]]; then
  eval "${STARTUP_CMD}"
  ok "PM2 startup systemd configured"
else
  ok "PM2 startup already configured (or command not found -- run manually if needed)"
fi

# ── 10. Caddyfile ─────────────────────────────────────────────────────────────

info "Writing /etc/caddy/Caddyfile"
cat > /etc/caddy/Caddyfile <<CADDYEOF
{
  email ${CADDY_EMAIL}
}

${CADDY_DOMAIN} {
  reverse_proxy localhost:${ROUTER_PORT}
}
CADDYEOF
ok "Caddyfile written"

# ── 11. Enable and start Caddy ────────────────────────────────────────────────

info "Enabling and starting Caddy"
systemctl daemon-reload
systemctl enable caddy
systemctl restart caddy
ok "Caddy running"

# ── 12. UFW firewall ──────────────────────────────────────────────────────────

info "Configuring UFW firewall"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   comment "SSH"
ufw allow 80/tcp   comment "HTTP (Caddy ACME)"
ufw allow 443/tcp  comment "HTTPS"
ufw --force enable
ok "UFW enabled: 22, 80, 443 open"

# ── Done -- print checklist ───────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          Kayzo VPS setup complete -- remaining steps         ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║                                                              ║"
echo "║  1. DNS (must be done before Caddy can get a TLS cert):      ║"
echo "║     A record: api.kayzo.ai -> $(curl -s ifconfig.me 2>/dev/null || echo '[this VPS IP]')                ║"
echo "║                                                              ║"
echo "║  2. Fill in all values in ${APP_DIR}/.env    ║"
echo "║     (ANTHROPIC_API_KEY, SUPABASE_*, STRIPE_*)                ║"
echo "║                                                              ║"
echo "║  3. Deploy Supabase migrations:                              ║"
echo "║     supabase db push  (run from your local machine)          ║"
echo "║                                                              ║"
echo "║  4. Deploy Edge Functions:                                   ║"
echo "║     supabase functions deploy validate-license \\             ║"
echo "║       get-preferences update-preferences log-usage \\        ║"
echo "║       stripe-webhook                                         ║"
echo "║                                                              ║"
echo "║  5. Start the router (after Prompt 6 is deployed):           ║"
echo "║     sudo -u kayzo pm2 start ${APP_DIR}/router.mjs \\     ║"
echo "║       --name kayzo-router                                    ║"
echo "║     sudo -u kayzo pm2 save                                   ║"
echo "║                                                              ║"
echo "║  6. Verify Caddy TLS cert:                                   ║"
echo "║     curl https://api.kayzo.ai/health                         ║"
echo "║                                                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
