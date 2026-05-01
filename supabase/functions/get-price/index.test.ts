import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler, normalizeHomeDepotResponse, normalizeLowesResponse } from "./index.ts";

declare global {
  var Deno: { env: { get: (key: string) => string | undefined } } | undefined;
}

type JsonResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

const SUPABASE_ANON_KEY = "test-supabase-anon-key";

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/get-price", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function makeUpstreamJsonResponse(
  payload: unknown,
  init: { ok?: boolean; status?: number } = {},
): JsonResponse {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    json: () => Promise.resolve(payload),
  };
}

describe("get-price edge function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.Deno = {
      env: {
        get: (key: string) => (key === "SUPABASE_ANON_KEY" ? SUPABASE_ANON_KEY : undefined),
      },
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.Deno = undefined;
  });

  describe("request validation", () => {
    it("returns 400 when store is missing", async () => {
      const res = await handler(
        makeRequest({ query: "2x4 lumber" }, { Authorization: `Bearer ${SUPABASE_ANON_KEY}` }),
      );
      expect(res.status).toBe(400);
      expect(res.headers.get("Content-Type")?.toLowerCase()).toContain("application/json");
      await expect(res.json()).resolves.toHaveProperty("error");
    });

    it("returns 400 when query is missing", async () => {
      const res = await handler(
        makeRequest({ store: "lowes" }, { Authorization: `Bearer ${SUPABASE_ANON_KEY}` }),
      );
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
    });

    it("returns 400 when store value is unknown", async () => {
      const res = await handler(
        makeRequest(
          { store: "walmart", query: "lumber" },
          { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        ),
      );
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
    });
  });

  describe("auth", () => {
    it("returns 401 when Authorization header is missing", async () => {
      const res = await handler(makeRequest({ store: "lowes", query: "lumber" }));
      expect(res.status).toBe(401);
      expect(res.headers.get("Content-Type")?.toLowerCase()).toContain("application/json");
      await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
    });

    it("returns 401 when bearer token is wrong", async () => {
      const res = await handler(
        makeRequest({ store: "lowes", query: "lumber" }, { Authorization: "Bearer wrong-token" }),
      );
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
    });

    it("allows request through when bearer token matches anon key", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeUpstreamJsonResponse({ items: [] })));

      const res = await handler(
        makeRequest(
          { store: "lowes", query: "lumber" },
          { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        ),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ products: [] });
    });
  });

  describe("Lowe's path", () => {
    it("calls a URL that includes 'lowe' and passes query + store_zip", async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeUpstreamJsonResponse({ items: [] }));
      vi.stubGlobal("fetch", mockFetch);

      await handler(
        makeRequest(
          { store: "lowes", query: "2x4 lumber", store_zip: "84101" },
          { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        ),
      );

      const urls = mockFetch.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.toLowerCase().includes("lowe"))).toBe(true);
      const calledUrl = urls[0];
      expect(calledUrl).toContain("searchTerm=2x4");
      expect(calledUrl).toContain("store_zip=84101");
    });

    it("returns normalized { products: [...] } on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeUpstreamJsonResponse({
            items: [
              {
                name: "2x4x8 Douglas Fir",
                regularPrice: "4.98",
                unit: "each",
                itemId: "1000012345",
                availabilityType: "IN_STOCK",
              },
            ],
          }),
        ),
      );

      const res = await handler(
        makeRequest(
          { store: "lowes", query: "2x4 lumber" },
          { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        ),
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as { products: Array<Record<string, unknown>> };
      expect(Array.isArray(json.products)).toBe(true);
      expect(json.products[0]).toMatchObject({
        name: "2x4x8 Douglas Fir",
        price: 4.98,
        unit: "each",
        sku: "1000012345",
        inStock: true,
      });
    });

    it("returns { products: [] } when retailer returns empty results", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeUpstreamJsonResponse({ items: [] })));

      const res = await handler(
        makeRequest(
          { store: "lowes", query: "nothing matches this" },
          { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        ),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ products: [] });
    });
  });

  describe("Home Depot path", () => {
    it("calls the Home Depot GraphQL endpoint and includes keyword + deliveryZip in payload", async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeUpstreamJsonResponse({ items: [] }));
      vi.stubGlobal("fetch", mockFetch);

      await handler(
        makeRequest(
          { store: "homedepot", query: "plywood", store_zip: "30301" },
          { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        ),
      );

      const calledUrl = String(mockFetch.mock.calls[0]?.[0] ?? "").toLowerCase();
      expect(calledUrl).toContain("apionline.homedepot.com");
      expect(calledUrl).toContain("graphql");

      const init = mockFetch.mock.calls[0]?.[1] as { method?: string; body?: string } | undefined;
      expect(init?.method).toBe("POST");
      expect(typeof init?.body).toBe("string");
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { keyword?: string; additionalSearchParams?: { deliveryZip?: string } };
      };
      expect(parsed.variables?.keyword).toBe("plywood");
      expect(parsed.variables?.additionalSearchParams?.deliveryZip).toBe("30301");
    });

    it("returns normalized { products: [...] } on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeUpstreamJsonResponse({
            data: {
              searchModel: {
                products: [
                  {
                    itemId: "204971292",
                    identifiers: { productLabel: "OSB 7/16 4x8" },
                    pricing: { value: 12.34 },
                    fulfillment: { shipping: { inStock: false } },
                  },
                ],
              },
            },
          }),
        ),
      );

      const res = await handler(
        makeRequest(
          { store: "homedepot", query: "osb" },
          { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        ),
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as { products: Array<Record<string, unknown>> };
      expect(json.products[0]).toMatchObject({
        name: "OSB 7/16 4x8",
        price: 12.34,
        unit: "each",
        sku: "204971292",
        inStock: false,
      });
    });

    it("returns { products: [] } when retailer returns empty results", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeUpstreamJsonResponse({ items: [] })));

      const res = await handler(
        makeRequest(
          { store: "homedepot", query: "nothing matches this" },
          { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        ),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ products: [] });
    });
  });

  describe("normalization", () => {
    it("maps retailer fields and ensures price is a number and inStock is a boolean", async () => {
      const lowes = normalizeLowesResponse({
        items: [
          {
            name: "Thing",
            regularPrice: "19.99",
            unit: "each",
            itemId: "123",
            availabilityType: "IN_STOCK",
          },
        ],
      });

      expect(lowes[0].price).toBeTypeOf("number");
      expect(lowes[0].inStock).toBeTypeOf("boolean");
      expect(lowes[0]).toMatchObject({
        name: "Thing",
        price: 19.99,
        unit: "each",
        sku: "123",
        inStock: true,
      });

      const hd = normalizeHomeDepotResponse({
        items: [
          {
            name: "Other thing",
            regularPrice: "5.50",
            unit: "bag",
            itemId: "abc",
            availabilityType: "OUT_OF_STOCK",
          },
        ],
      });

      expect(hd[0].price).toBeTypeOf("number");
      expect(hd[0].inStock).toBeTypeOf("boolean");
      expect(hd[0]).toMatchObject({
        name: "Other thing",
        price: 5.5,
        unit: "bag",
        sku: "abc",
        inStock: false,
      });
    });
  });

  describe("error handling", () => {
    it("returns 502 with { error } when retailer fetch throws", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

      const res = await handler(
        makeRequest(
          { store: "lowes", query: "lumber" },
          { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        ),
      );

      expect(res.status).toBe(502);
      expect(res.headers.get("Content-Type")?.toLowerCase()).toContain("application/json");
      await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
    });

    it("returns 502 when retailer returns non-200", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            makeUpstreamJsonResponse({ message: "nope" }, { ok: false, status: 500 }),
          ),
      );

      const res = await handler(
        makeRequest(
          { store: "homedepot", query: "plywood" },
          { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        ),
      );

      expect(res.status).toBe(502);
      expect(res.headers.get("Content-Type")?.toLowerCase()).toContain("application/json");
      await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
    });
  });
});
