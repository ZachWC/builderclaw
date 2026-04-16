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

  // ── Proxy to localhost:{port} ─────────────────────────────────────────────
  const upstream = new WebSocket(`ws://localhost:${customer.port}`, {
    headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== "host")),
  });

  // Buffer messages that arrive from the client before the upstream is open
  /** @type {Array<{ data: import("ws").RawData, isBinary: boolean }>} */
  const clientMessageBuffer = [];
  const bufferClientMessage = (data, isBinary) => {
    clientMessageBuffer.push({ data, isBinary });
  };
  clientWs.on("message", bufferClientMessage);

  // Give the upstream 5s to connect
  const connectTimeout = setTimeout(() => {
    if (upstream.readyState !== WebSocket.OPEN) {
      upstream.terminate();
      clientWs.close(4503, "gateway unreachable");
    }
  }, 5_000);

  upstream.once("open", () => {
    clearTimeout(connectTimeout);

    // Flush any messages buffered while upstream was connecting
    clientWs.off("message", bufferClientMessage);
    for (const { data, isBinary } of clientMessageBuffer) {
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
