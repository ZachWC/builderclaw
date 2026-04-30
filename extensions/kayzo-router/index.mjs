/**
 * Kayzo Gateway API Router
 *
 * Standalone Express + WebSocket proxy that runs as a separate PM2 process
 * on port 9000.  All per-customer gateway instances run on private localhost
 * ports; this router authenticates requests and proxies them through.
 *
 * Routes:
 *   GET  /health                  -- liveness probe
 *   WS   /ws/:slug                -- authenticated WebSocket proxy to customer gateway
 *   GET  /api/preferences/:slug   -- read contractor_preferences (JWT required)
 *   PATCH /api/preferences/:slug  -- write contractor_preferences (JWT required)
 *   *    /api/:slug/*             -- unauthenticated proxy for Gmail webhooks (rate-limited)
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";
import { WebSocket, WebSocketServer } from "ws";

// ── Env ───────────────────────────────────────────────────────────────────────

// Load .env from the repo root (two directories up from extensions/kayzo-router/)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../../.env") });

const PORT = parseInt(process.env.ROUTER_PORT ?? "9000", 10);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[router] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── Public URLs (used for redirects + CORS) ───────────────────────────────────
const ROUTER_PUBLIC_URL = process.env.ROUTER_PUBLIC_URL ?? "https://api.kayzo.ai";
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL ?? "https://app.kayzo.ai";

// ── Customer cache (slug → { provisioned_port, auth_user_id }, TTL 60s) ──────

/** @type {Map<string, { port: number, authUserId: string | null, expiresAt: number }>} */
const customerCache = new Map();
const CACHE_TTL_MS = 60_000;

/**
 * Look up a customer by slug.  Returns null when slug is unknown.
 * @returns {{ port: number, authUserId: string | null } | null}
 */
async function lookupCustomer(slug) {
  const now = Date.now();
  const cached = customerCache.get(slug);
  if (cached && cached.expiresAt > now) {
    return { port: cached.port, authUserId: cached.authUserId };
  }

  const { data, error } = await supabase
    .from("customers")
    .select("provisioned_port, auth_user_id")
    .eq("slug", slug)
    .single();

  if (error || !data || !data.provisioned_port) {
    return null;
  }

  customerCache.set(slug, {
    port: data.provisioned_port,
    authUserId: data.auth_user_id ?? null,
    expiresAt: now + CACHE_TTL_MS,
  });

  return { port: data.provisioned_port, authUserId: data.auth_user_id ?? null };
}

// ── Gateway token helpers ─────────────────────────────────────────────────────

const CUSTOMERS_DIR = process.env.KAYZO_CUSTOMERS_DIR ?? "/home/kayzo/customers";

/**
 * Read the gateway auth token from a customer's kayzo.json, if present.
 * Returns null if the file is missing or has no auth token.
 * @returns {Promise<string | null>}
 */
async function readGatewayToken(slug) {
  try {
    const text = await readFile(`${CUSTOMERS_DIR}/${slug}/kayzo.json`, "utf8");
    const config = JSON.parse(text);
    return config?.gateway?.auth?.token ?? null;
  } catch {
    return null;
  }
}

// ── JWT helpers ───────────────────────────────────────────────────────────────

/**
 * Verify a Supabase JWT and return the payload.
 * Throws if invalid.
 */
async function verifyJwt(token) {
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    throw new Error(error?.message ?? "invalid token");
  }
  return { sub: data.user.id, email: data.user.email };
}

/**
 * Extract and verify the Bearer token from an Authorization header.
 * Returns the JWT payload, or throws on failure.
 */
async function authFromHeader(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("missing or malformed Authorization header");
  }
  return verifyJwt(authHeader.slice(7));
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.disable("x-powered-by");

// ── CORS (Vercel app → router API) ────────────────────────────────────────────
//
// The frontend is served from a different origin (e.g. https://app.kayzo.app),
// so browser requests to https://api.kayzo.app require CORS headers.
const DEFAULT_ALLOWED_ORIGINS = new Set([
  APP_PUBLIC_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

// Only allow Kayzo-owned Vercel preview deployments, not arbitrary *.vercel.app origins.
const KAYZO_PREVIEW_ORIGIN = /^https:\/\/kayzo-[a-z0-9-]+\.vercel\.app$/;

/** @param {string | undefined} origin */
function isAllowedOrigin(origin) {
  if (!origin) {
    return false;
  }
  if (DEFAULT_ALLOWED_ORIGINS.has(origin)) {
    return true;
  }
  return KAYZO_PREVIEW_ORIGIN.test(origin);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// ── /health ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ── /api/preferences/:slug ────────────────────────────────────────────────────

const preferencesRouter = express.Router({ mergeParams: true });

preferencesRouter.use(async (req, res, next) => {
  try {
    const payload = await authFromHeader(req.headers.authorization);
    // eslint-disable-next-line @typescript-eslint/await-thenable
    const customer = await lookupCustomer(req.params.slug);
    if (!customer) {
      return res.status(404).json({ error: "customer not found" });
    }
    if (customer.authUserId && payload.sub !== customer.authUserId) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.locals.slug = req.params.slug;
    next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
});

preferencesRouter.get("/", async (req, res) => {
  const { data, error } = await supabase
    .from("contractor_preferences")
    .select("*")
    .eq("license_key", res.locals.slug)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: "preferences not found" });
  }

  res.json({
    ordering: { mode: data.ordering_mode, threshold: data.ordering_threshold },
    scheduling: { mode: data.scheduling_mode, threshold: data.scheduling_threshold },
    emailReplies: { mode: data.email_replies_mode },
    flagging: { mode: data.flagging_mode },
    bidMarkup: data.bid_markup,
    updatedAt: data.updated_at,
  });
});

const VALID_MODES = new Set(["always_ask", "threshold", "always_act"]);

preferencesRouter.patch("/", async (req, res) => {
  const slug = res.locals.slug;
  const body = req.body ?? {};

  // Validate modes
  for (const field of ["ordering_mode", "scheduling_mode", "email_replies_mode", "flagging_mode"]) {
    if (body[field] !== undefined && !VALID_MODES.has(body[field])) {
      return res
        .status(400)
        .json({ error: `${field} must be always_ask | threshold | always_act` });
    }
  }
  if (
    body.ordering_threshold !== undefined &&
    (typeof body.ordering_threshold !== "number" || body.ordering_threshold < 0)
  ) {
    return res.status(400).json({ error: "ordering_threshold must be a non-negative number" });
  }
  if (
    body.bid_markup !== undefined &&
    (typeof body.bid_markup !== "number" || body.bid_markup < 0 || body.bid_markup > 200)
  ) {
    return res.status(400).json({ error: "bid_markup must be between 0 and 200" });
  }

  // Build update payload
  const update = { updated_at: new Date().toISOString() };
  for (const field of [
    "ordering_mode",
    "ordering_threshold",
    "scheduling_mode",
    "scheduling_threshold",
    "email_replies_mode",
    "flagging_mode",
    "bid_markup",
  ]) {
    if (body[field] !== undefined) {
      update[field] = body[field];
    }
  }

  // Get license_key for this slug
  const { data: customer } = await supabase
    .from("customers")
    .select("license_key")
    .eq("slug", slug)
    .single();

  if (!customer) {
    return res.status(404).json({ error: "customer not found" });
  }

  const { error } = await supabase
    .from("contractor_preferences")
    .upsert({ license_key: customer.license_key, ...update }, { onConflict: "license_key" });

  if (error) {
    console.error("[router] preferences upsert error:", error);
    return res.status(500).json({ error: "failed to update preferences" });
  }

  // Write refresh flag for running gateway
  import("node:fs/promises")
    .then(({ writeFile }) =>
      writeFile(`/tmp/kayzo-prefs-refresh-${customer.license_key}`, new Date().toISOString()),
    )
    .catch(() => {
      // Non-fatal; gateway polls Supabase as fallback
    });

  res.json({ ok: true });
});

app.use("/api/preferences/:slug", preferencesRouter);

// ── /api/integrations/:slug ───────────────────────────────────────────────────
// Manages per-contractor integrations: Gmail OAuth, Lowe's, Home Depot.
// Must be registered BEFORE the generic /api/:slug/* webhook proxy catch-all.

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// ── Shared Gmail OAuth callback (no slug in path — one URL for all customers) ─
// Registered BEFORE the per-slug integrationsRouter so Express matches it first.

app.get("/api/integrations/gmail/callback", async (req, res) => {
  // Safely extract string query params — Express types them as string | string[] | object
  const qstr = (v) => (typeof v === "string" ? v : undefined);
  const code = qstr(req.query.code);
  const state = qstr(req.query.state);
  const oauthError = qstr(req.query.error);
  const frontendBase = `${APP_PUBLIC_URL}/integrations`;

  if (oauthError || !code || !state) {
    return res.redirect(
      `${frontendBase}?gmail=error&reason=${encodeURIComponent(oauthError ?? "missing_code")}`,
    );
  }

  let slug, nonce;
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    slug = parsed.slug;
    nonce = parsed.nonce;
  } catch {
    return res.redirect(`${frontendBase}?gmail=error&reason=invalid_state`);
  }

  if (!slug || !nonce) {
    return res.redirect(`${frontendBase}?gmail=error&reason=invalid_state`);
  }

  const { data: customer } = await supabase
    .from("customers")
    .select("license_key")
    .eq("slug", slug)
    .single();
  if (!customer) {
    return res.redirect(`${frontendBase}?gmail=error&reason=customer_not_found`);
  }

  // Verify CSRF nonce
  const { data: integ } = await supabase
    .from("contractor_integrations")
    .select("gmail_oauth_state")
    .eq("license_key", customer.license_key)
    .single();

  if (!integ || integ.gmail_oauth_state !== nonce) {
    return res.redirect(`${frontendBase}?gmail=error&reason=state_mismatch`);
  }

  // Exchange code for tokens
  const sharedCallbackUrl = `${ROUTER_PUBLIC_URL}/api/integrations/gmail/callback`;
  let tokens;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: sharedCallbackUrl,
        grant_type: "authorization_code",
      }),
    });
    tokens = await tokenRes.json();
    if (tokens.error) {
      throw new Error(tokens.error_description ?? tokens.error);
    }
  } catch (err) {
    console.error("[router] Gmail token exchange error:", err.message);
    return res.redirect(`${frontendBase}?gmail=error&reason=token_exchange_failed`);
  }

  // Fetch the user's Gmail address
  let gmailEmail = null;
  try {
    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = await userRes.json();
    gmailEmail = userInfo.email ?? null;
  } catch {
    // Non-fatal — email just won't display
  }

  const expiry = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  await supabase.from("contractor_integrations").upsert(
    {
      license_key: customer.license_key,
      gmail_connected: true,
      gmail_email: gmailEmail,
      gmail_refresh_token: tokens.refresh_token ?? null,
      gmail_access_token: tokens.access_token ?? null,
      gmail_token_expiry: expiry,
      gmail_oauth_state: null, // clear nonce
      updated_at: new Date().toISOString(),
    },
    { onConflict: "license_key" },
  );

  return res.redirect(`${frontendBase}?gmail=connected`);
});

// ── Per-slug integrations router ──────────────────────────────────────────────

const integrationsRouter = express.Router({ mergeParams: true });

integrationsRouter.use(async (req, res, next) => {
  try {
    const payload = await authFromHeader(req.headers.authorization);
    // eslint-disable-next-line @typescript-eslint/await-thenable
    const customer = await lookupCustomer(req.params.slug);
    if (!customer) {
      return res.status(404).json({ error: "customer not found" });
    }
    if (customer.authUserId && payload.sub !== customer.authUserId) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.locals.slug = req.params.slug;
    next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
});

/** Return integrations status (no raw tokens exposed). */
integrationsRouter.get("/", async (req, res) => {
  const { data: customer } = await supabase
    .from("customers")
    .select("license_key")
    .eq("slug", res.locals.slug)
    .single();
  if (!customer) {
    return res.status(404).json({ error: "customer not found" });
  }

  // Upsert to ensure row exists for older customers provisioned before this migration
  await supabase
    .from("contractor_integrations")
    .upsert(
      { license_key: customer.license_key },
      { onConflict: "license_key", ignoreDuplicates: true },
    );

  const { data } = await supabase
    .from("contractor_integrations")
    .select(
      "gmail_connected,gmail_email,lowes_account_number,lowes_api_key,homedepot_account_number,homedepot_api_key,updated_at",
    )
    .eq("license_key", customer.license_key)
    .single();

  res.json({
    gmail: {
      connected: data?.gmail_connected ?? false,
      email: data?.gmail_email ?? null,
      oauthAvailable: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    },
    lowes: {
      configured: !!(data?.lowes_api_key || data?.lowes_account_number),
      accountNumber: data?.lowes_account_number ?? null,
      // Never expose the raw API key — just confirm it's set
      hasApiKey: !!data?.lowes_api_key,
    },
    homedepot: {
      configured: !!(data?.homedepot_api_key || data?.homedepot_account_number),
      accountNumber: data?.homedepot_account_number ?? null,
      hasApiKey: !!data?.homedepot_api_key,
    },
    updatedAt: data?.updated_at ?? null,
  });
});

/** Update Lowe's / Home Depot credentials. */
integrationsRouter.patch("/", async (req, res) => {
  const { data: customer } = await supabase
    .from("customers")
    .select("license_key")
    .eq("slug", res.locals.slug)
    .single();
  if (!customer) {
    return res.status(404).json({ error: "customer not found" });
  }

  const body = req.body ?? {};
  const update = { updated_at: new Date().toISOString() };

  if (body.lowes_api_key !== undefined) {
    update.lowes_api_key = body.lowes_api_key;
  }
  if (body.lowes_account_number !== undefined) {
    update.lowes_account_number = body.lowes_account_number;
  }
  if (body.homedepot_api_key !== undefined) {
    update.homedepot_api_key = body.homedepot_api_key;
  }
  if (body.homedepot_account_number !== undefined) {
    update.homedepot_account_number = body.homedepot_account_number;
  }

  const { error } = await supabase
    .from("contractor_integrations")
    .upsert({ license_key: customer.license_key, ...update }, { onConflict: "license_key" });

  if (error) {
    console.error("[router] integrations upsert error:", error);
    return res.status(500).json({ error: "failed to update integrations" });
  }
  res.json({ ok: true });
});

/** Start Gmail OAuth flow — returns the Google authorization URL. */
integrationsRouter.get("/gmail/connect", async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: "Gmail OAuth not configured on this server" });
  }

  const { data: customer } = await supabase
    .from("customers")
    .select("license_key")
    .eq("slug", res.locals.slug)
    .single();
  if (!customer) {
    return res.status(404).json({ error: "customer not found" });
  }

  // Generate a CSRF state token and persist it briefly
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const state = Buffer.from(JSON.stringify({ slug: res.locals.slug, nonce })).toString("base64url");

  await supabase.from("contractor_integrations").upsert(
    {
      license_key: customer.license_key,
      gmail_oauth_state: nonce,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "license_key" },
  );

  // Single shared callback URL — the same for every customer.
  // The slug is encoded in the state param instead.
  const callbackUrl = `${ROUTER_PUBLIC_URL}/api/integrations/gmail/callback`;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope:
      "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    state,
  });

  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

/** Disconnect Gmail. */
integrationsRouter.delete("/gmail", async (req, res) => {
  const { data: customer } = await supabase
    .from("customers")
    .select("license_key")
    .eq("slug", res.locals.slug)
    .single();
  if (!customer) {
    return res.status(404).json({ error: "customer not found" });
  }

  await supabase.from("contractor_integrations").upsert(
    {
      license_key: customer.license_key,
      gmail_connected: false,
      gmail_email: null,
      gmail_refresh_token: null,
      gmail_access_token: null,
      gmail_token_expiry: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "license_key" },
  );

  res.json({ ok: true });
});

app.use("/api/integrations/:slug", integrationsRouter);

// ── /api/:slug/* (Gmail webhook proxy, rate-limited) ──────────────────────────

const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 100,
  keyGenerator: (req) => req.params.slug,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate limit exceeded" },
});

app.use("/api/:slug", webhookLimiter, async (req, res) => {
  const { slug } = req.params;
  const customer = await lookupCustomer(slug).catch(() => null);
  if (!customer) {
    return res.status(404).json({ error: "customer not found" });
  }

  // Strip /api/:slug prefix to get the remaining path.
  // Use originalUrl (never modified by Express) so the regex always matches
  // from the full request path rather than whatever Express has already stripped.
  const remaining = req.originalUrl.replace(/^\/api\/[^/]+/, "") || "/";
  const targetUrl = `http://localhost:${customer.port}${remaining}`;

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: {
        ...req.headers,
        host: `localhost:${customer.port}`,
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(15_000),
    });

    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((value, key) => {
      if (!["transfer-encoding", "connection"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    const text = await upstreamRes.text();
    res.send(text);
  } catch (err) {
    console.error(`[router] webhook proxy error for slug=${String(slug)}:`, err);
    res.status(503).json({ error: "gateway unreachable" });
  }
});

// ── HTTP server + WebSocket upgrade ──────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const match = req.url?.match(/^\/ws\/([^/?#]+)/);
  if (!match) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    wss.emit("connection", clientWs, req, match[1]);
  });
});

wss.on("connection", async (clientWs, req, slug) => {
  console.log(`[router] WS connection: slug=${slug}`);

  // Buffer client messages immediately — before any async work — so we never
  // drop frames (e.g. the gateway connect handshake) that arrive while we are
  // still doing JWT verification and customer lookup.
  /** @type {Array<{ data: import("ws").RawData, isBinary: boolean }>} */
  const clientMessageBuffer = [];
  const bufferClientMessage = (data, isBinary) => {
    clientMessageBuffer.push({ data, isBinary });
  };
  clientWs.on("message", bufferClientMessage);

  // ── Authenticate ──────────────────────────────────────────────────────────
  // Accept token from Authorization header or ?token= query param (browser
  // WebSocket APIs cannot set custom headers, so query param is the fallback).
  let payload;
  try {
    const authHeader = req.headers["authorization"];
    if (authHeader) {
      payload = await authFromHeader(authHeader);
    } else {
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token");
      if (!token) {
        throw new Error("no token");
      }
      payload = await verifyJwt(token);
    }
  } catch (err) {
    console.log(`[router] WS auth failed slug=${slug}: ${err.message}`);
    clientWs.close(4001, "unauthorized");
    return;
  }

  // ── Look up customer ──────────────────────────────────────────────────────
  let customer;
  try {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    customer = await lookupCustomer(slug);
  } catch {
    clientWs.close(4500, "internal error");
    return;
  }

  if (!customer) {
    clientWs.close(4004, "customer not found");
    return;
  }

  // Verify JWT sub matches the customer's auth user
  if (customer.authUserId && payload.sub !== customer.authUserId) {
    clientWs.close(4003, "forbidden");
    return;
  }

  // Read the gateway's auth token so we can inject it into the connect frame
  const gatewayToken = await readGatewayToken(slug);

  // ── Proxy to localhost:{port} ─────────────────────────────────────────────
  // Strip proxy/forwarding headers so the gateway sees a clean loopback
  // connection and treats it as a trusted local client (no auth required).
  const STRIP_UPSTREAM = new Set([
    "host",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-real-ip",
    "cf-connecting-ip",
    "cf-ray",
  ]);
  const upstream = new WebSocket(`ws://localhost:${customer.port}`, {
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => !STRIP_UPSTREAM.has(k.toLowerCase())),
    ),
  });

  // Give the upstream 5s to connect
  const connectTimeout = setTimeout(() => {
    if (upstream.readyState !== WebSocket.OPEN) {
      upstream.terminate();
      clientWs.close(4503, "gateway unreachable");
    }
  }, 5_000);

  upstream.once("open", () => {
    clearTimeout(connectTimeout);

    // Flush any messages buffered while upstream was connecting.
    // If the gateway has an auth token, inject it into the connect frame.
    clientWs.off("message", bufferClientMessage);
    for (const { data, isBinary } of clientMessageBuffer) {
      if (gatewayToken && !isBinary) {
        try {
          const raw = Buffer.isBuffer(data)
            ? data.toString("utf8")
            : data instanceof ArrayBuffer
              ? Buffer.from(data).toString("utf8")
              : "";
          const frame = JSON.parse(raw);
          if (frame?.type === "req" && frame?.method === "connect") {
            frame.params = frame.params ?? {};
            frame.params.auth = { ...frame.params.auth, token: gatewayToken };
            upstream.send(JSON.stringify(frame));
            continue;
          }
        } catch {
          // Not JSON — fall through to raw send
        }
      }
      upstream.send(data, { binary: isBinary });
    }
    clientMessageBuffer.length = 0;

    clientWs.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });
  });

  upstream.once("error", (err) => {
    clearTimeout(connectTimeout);
    console.error(`[router] upstream WS error slug=${slug} port=${customer.port}:`, err.message);
    clientWs.close(4503, "gateway unreachable");
  });

  upstream.once("close", (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(code, reason);
    }
  });

  clientWs.once("close", () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  });

  clientWs.once("error", () => {
    upstream.terminate();
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[router] Kayzo gateway router listening on port ${PORT}`);
});
