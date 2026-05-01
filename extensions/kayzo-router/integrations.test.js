/**
 * Tests for GET /api/integrations/:slug and PATCH /api/integrations/:slug.
 *
 * NOTE: These tests require the router to export `app` so that supertest can
 * attach to it without starting the HTTP server. To enable this, add at the
 * bottom of index.mjs (before `server.listen`):
 *
 *   export { app };
 *
 * And install the test peer dep:
 *
 *   pnpm add -D supertest --filter kayzo-router   (or at the monorepo root)
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeIsAllowedOrigin } from "./cors.mjs";

// ── Hoisted mock setup ───────────────────────────────────────────────────────
//
// vi.hoisted runs before any module evaluation, so we can set env vars that
// the router checks synchronously at module load time (it calls process.exit(1)
// if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY are absent).

const { mockSupabase, mockAuthUser } = vi.hoisted(() => {
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.ROUTER_PORT = "19099"; // avoid port conflict

  const mockSingle = vi.fn();
  const mockEq = vi.fn();
  const mockSelect = vi.fn(() => ({ eq: mockEq }));
  const mockUpsert = vi.fn().mockResolvedValue({ error: null });
  const mockFrom = vi.fn(() => ({
    select: mockSelect,
    upsert: mockUpsert,
    eq: mockEq,
  }));
  const mockAuthGetUser = vi.fn();

  // Wire up chainable returns so callers can do .from().select().eq().single()
  mockEq.mockReturnValue({
    single: mockSingle,
    eq: mockEq,
    ignoreDuplicates: vi.fn().mockReturnThis(),
  });

  const mockSupabase = {
    from: mockFrom,
    auth: { getUser: mockAuthGetUser },
    _mocks: { mockFrom, mockSelect, mockEq, mockSingle, mockUpsert, mockAuthGetUser },
  };

  const mockAuthUser = { id: "user-abc", email: "test@example.com" };

  return { mockSupabase, mockAuthUser };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockSupabase,
}));

vi.mock("dotenv", () => ({
  default: { config: vi.fn() },
}));

// ── CORS origin logic tests (pure — no HTTP server needed) ───────────────────

// Use the real implementation. Production APP_PUBLIC_URL is "https://app.kayzo.app";
// we pass it explicitly so the tests exercise the real isAllowedOrigin logic.
const isAllowedOrigin = makeIsAllowedOrigin("https://app.kayzo.app");

describe("CORS origin allowlist", () => {
  it("allows the production app origin", () => {
    expect(isAllowedOrigin("https://app.kayzo.app")).toBe(true);
  });

  it("allows localhost:3000 for local development", () => {
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
  });

  it("allows 127.0.0.1:3000 for local development", () => {
    expect(isAllowedOrigin("http://127.0.0.1:3000")).toBe(true);
  });

  it("allows Kayzo-prefixed Vercel preview deployments", () => {
    expect(isAllowedOrigin("https://kayzo-abc123def.vercel.app")).toBe(true);
    expect(isAllowedOrigin("https://kayzo-feature-branch.vercel.app")).toBe(true);
  });

  it("rejects arbitrary vercel.app deployments that are not Kayzo-owned", () => {
    expect(isAllowedOrigin("https://other-team-abc123.vercel.app")).toBe(false);
    expect(isAllowedOrigin("https://attacker-kayzo.vercel.app")).toBe(false);
  });

  it("rejects an absent origin", () => {
    expect(isAllowedOrigin(undefined)).toBe(false);
  });

  it("rejects arbitrary third-party origins", () => {
    expect(isAllowedOrigin("https://evil.com")).toBe(false);
  });

  it("rejects http variant of the production domain", () => {
    expect(isAllowedOrigin("http://app.kayzo.app")).toBe(false);
  });
});

// ── HTTP-level integrations endpoint tests ────────────────────────────────────
//
// These tests require `export { app }` in index.mjs and `supertest` installed.
// They will fail until those two changes land — that is the TDD intent.

describe("GET /api/integrations/:slug", () => {
  let request;

  beforeAll(async () => {
    const supertest = (await import("supertest")).default;
    // Router must export `app` for this import to work
    const { app } = await import("./index.mjs");
    request = supertest(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase._mocks.mockUpsert.mockResolvedValue({ error: null });
    mockSupabase._mocks.mockFrom.mockReturnValue({
      select: mockSupabase._mocks.mockSelect,
      upsert: mockSupabase._mocks.mockUpsert,
      eq: mockSupabase._mocks.mockEq,
    });
    mockSupabase._mocks.mockSelect.mockReturnValue({ eq: mockSupabase._mocks.mockEq });
    mockSupabase._mocks.mockEq.mockReturnValue({
      single: mockSupabase._mocks.mockSingle,
      eq: mockSupabase._mocks.mockEq,
      ignoreDuplicates: vi.fn().mockReturnThis(),
    });
  });

  function stubValidAuth() {
    mockSupabase._mocks.mockAuthGetUser.mockResolvedValue({
      data: { user: mockAuthUser },
      error: null,
    });
  }

  function stubCustomerLookup({ authUserId = mockAuthUser.id } = {}) {
    mockSupabase._mocks.mockSingle.mockResolvedValueOnce({
      data: { provisioned_port: 3001, auth_user_id: authUserId },
      error: null,
    });
  }

  function stubLicenseKeyLookup() {
    mockSupabase._mocks.mockSingle.mockResolvedValueOnce({
      data: { license_key: "test-license-key" },
      error: null,
    });
  }

  function stubIntegrationsRow(overrides = {}) {
    const row = {
      gmail_connected: false,
      gmail_email: null,
      lowes_account_number: null,
      lowes_api_key: null,
      homedepot_account_number: null,
      homedepot_api_key: null,
      updated_at: new Date().toISOString(),
      ...overrides,
    };
    mockSupabase._mocks.mockSingle.mockResolvedValueOnce({ data: row, error: null });
  }

  it("returns 401 when no Authorization header is present", async () => {
    const res = await request.get("/api/integrations/testslug");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the JWT is invalid", async () => {
    mockSupabase._mocks.mockAuthGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "invalid token" },
    });

    const res = await request
      .get("/api/integrations/testslug")
      .set("Authorization", "Bearer bad-token");

    expect(res.status).toBe(401);
  });

  it("returns 404 when the slug does not match any customer", async () => {
    stubValidAuth();
    mockSupabase._mocks.mockSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "no rows" },
    });

    const res = await request
      .get("/api/integrations/unknown-slug")
      .set("Authorization", "Bearer test-jwt");

    expect(res.status).toBe(404);
  });

  it("returns 403 when the JWT user does not own the customer slug", async () => {
    mockSupabase._mocks.mockAuthGetUser.mockResolvedValue({
      data: { user: { id: "different-user-id", email: "other@example.com" } },
      error: null,
    });
    stubCustomerLookup({ authUserId: "owner-user-id" });

    const res = await request
      .get("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt");

    expect(res.status).toBe(403);
  });

  it("returns 200 with gmail, lowes, and homedepot keys in body", async () => {
    stubValidAuth();
    stubCustomerLookup();
    stubLicenseKeyLookup();
    stubIntegrationsRow();

    const res = await request
      .get("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("gmail");
    expect(res.body).toHaveProperty("lowes");
    expect(res.body).toHaveProperty("homedepot");
  });

  it("never exposes the raw Lowe's API key — only hasApiKey: true", async () => {
    stubValidAuth();
    stubCustomerLookup();
    stubLicenseKeyLookup();
    stubIntegrationsRow({ lowes_api_key: "super-secret-lp-key", lowes_account_number: "ACC-123" });

    const res = await request
      .get("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt");

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("super-secret-lp-key");
    expect(res.body.lowes.hasApiKey).toBe(true);
    expect(res.body.lowes.accountNumber).toBe("ACC-123");
  });

  it("never exposes the raw Home Depot API key — only hasApiKey: true", async () => {
    stubValidAuth();
    stubCustomerLookup();
    stubLicenseKeyLookup();
    stubIntegrationsRow({ homedepot_api_key: "super-secret-hd-key" });

    const res = await request
      .get("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt");

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("super-secret-hd-key");
    expect(res.body.homedepot.hasApiKey).toBe(true);
  });

  it("reports lowes.configured=true when api key is set", async () => {
    stubValidAuth();
    stubCustomerLookup();
    stubLicenseKeyLookup();
    stubIntegrationsRow({ lowes_api_key: "lp-key" });

    const res = await request
      .get("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt");

    expect(res.body.lowes.configured).toBe(true);
  });

  it("reports lowes.configured=false when credentials are absent", async () => {
    stubValidAuth();
    stubCustomerLookup();
    stubLicenseKeyLookup();
    stubIntegrationsRow({ lowes_api_key: null, lowes_account_number: null });

    const res = await request
      .get("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt");

    expect(res.body.lowes.configured).toBe(false);
    expect(res.body.lowes.hasApiKey).toBe(false);
  });

  it("reports lowes.configured=true when only account number is set", async () => {
    stubValidAuth();
    stubCustomerLookup();
    stubLicenseKeyLookup();
    stubIntegrationsRow({ lowes_api_key: null, lowes_account_number: "ACC-123" });

    const res = await request
      .get("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt");

    expect(res.body.lowes.configured).toBe(true);
  });
});

describe("PATCH /api/integrations/:slug", () => {
  let request;

  beforeAll(async () => {
    const supertest = (await import("supertest")).default;
    const { app } = await import("./index.mjs");
    request = supertest(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase._mocks.mockUpsert.mockResolvedValue({ error: null });
    mockSupabase._mocks.mockFrom.mockReturnValue({
      select: mockSupabase._mocks.mockSelect,
      upsert: mockSupabase._mocks.mockUpsert,
      eq: mockSupabase._mocks.mockEq,
    });
    mockSupabase._mocks.mockSelect.mockReturnValue({ eq: mockSupabase._mocks.mockEq });
    mockSupabase._mocks.mockEq.mockReturnValue({
      single: mockSupabase._mocks.mockSingle,
      eq: mockSupabase._mocks.mockEq,
    });
  });

  function stubValidAuth() {
    mockSupabase._mocks.mockAuthGetUser.mockResolvedValue({
      data: { user: mockAuthUser },
      error: null,
    });
  }

  function stubCustomerLookupAndLicenseKey() {
    // lookupCustomer → customers.provisioned_port + auth_user_id
    mockSupabase._mocks.mockSingle
      .mockResolvedValueOnce({
        data: { provisioned_port: 3001, auth_user_id: mockAuthUser.id },
        error: null,
      })
      // PATCH handler re-queries for license_key
      .mockResolvedValueOnce({
        data: { license_key: "test-license-key" },
        error: null,
      });
  }

  it("returns 401 without auth", async () => {
    const res = await request
      .patch("/api/integrations/testslug")
      .send({ lowes_account_number: "123" });
    expect(res.status).toBe(401);
  });

  it("returns 200 and saves Lowe's account number", async () => {
    stubValidAuth();
    stubCustomerLookupAndLicenseKey();

    const res = await request
      .patch("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt")
      .send({ lowes_account_number: "ACC-9999" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const upsertArgs = mockSupabase._mocks.mockUpsert.mock.calls[0][0];
    expect(upsertArgs.lowes_account_number).toBe("ACC-9999");
  });

  it("saves the Lowe's API key when provided", async () => {
    stubValidAuth();
    stubCustomerLookupAndLicenseKey();

    await request
      .patch("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt")
      .send({ lowes_api_key: "new-lp-key" });

    const upsertArgs = mockSupabase._mocks.mockUpsert.mock.calls[0][0];
    expect(upsertArgs.lowes_api_key).toBe("new-lp-key");
  });

  it("saves the Home Depot API key when provided", async () => {
    stubValidAuth();
    stubCustomerLookupAndLicenseKey();

    await request
      .patch("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt")
      .send({ homedepot_api_key: "new-hd-key" });

    const upsertArgs = mockSupabase._mocks.mockUpsert.mock.calls[0][0];
    expect(upsertArgs.homedepot_api_key).toBe("new-hd-key");
  });

  it("saves the Home Depot account number when provided", async () => {
    stubValidAuth();
    stubCustomerLookupAndLicenseKey();

    await request
      .patch("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt")
      .send({ homedepot_account_number: "PRO-4444" });

    const upsertArgs = mockSupabase._mocks.mockUpsert.mock.calls[0][0];
    expect(upsertArgs.homedepot_account_number).toBe("PRO-4444");
  });

  it("allows updating both stores in a single PATCH", async () => {
    stubValidAuth();
    stubCustomerLookupAndLicenseKey();

    await request
      .patch("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt")
      .send({ lowes_account_number: "L-123", homedepot_account_number: "H-456" });

    const upsertArgs = mockSupabase._mocks.mockUpsert.mock.calls[0][0];
    expect(upsertArgs.lowes_account_number).toBe("L-123");
    expect(upsertArgs.homedepot_account_number).toBe("H-456");
  });

  it("returns 500 when the Supabase upsert fails", async () => {
    stubValidAuth();
    stubCustomerLookupAndLicenseKey();
    mockSupabase._mocks.mockUpsert.mockResolvedValue({ error: { message: "db error" } });

    const res = await request
      .patch("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt")
      .send({ lowes_account_number: "ACC-123" });

    expect(res.status).toBe(500);
  });

  it("does not write Gmail-related fields via this endpoint", async () => {
    stubValidAuth();
    stubCustomerLookupAndLicenseKey();

    await request
      .patch("/api/integrations/testslug")
      .set("Authorization", "Bearer test-jwt")
      .send({ gmail_connected: true, gmail_refresh_token: "evil-token" });

    // Should save ok (unknown fields are ignored), but should NOT write the Gmail token
    const upsertArgs = mockSupabase._mocks.mockUpsert.mock.calls[0]?.[0] ?? {};
    expect(upsertArgs).not.toHaveProperty("gmail_refresh_token");
    expect(upsertArgs).not.toHaveProperty("gmail_connected");
  });
});
