type Store = "lowes" | "homedepot";

export type GetPriceRequestBody = {
  store?: string;
  query?: string;
  store_zip?: string;
};

export type NormalizedProduct = {
  name: string;
  price: number;
  unit: string;
  sku: string;
  inStock: boolean;
};

export type GetPriceResponseBody = { products: NormalizedProduct[] } | { error: string };

function jsonResponse(status: number, body: GetPriceResponseBody): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }
  const m = authHeader.match(/^\s*Bearer\s+(.+)\s*$/i);
  return m?.[1] ?? null;
}

function isSupportedStore(store: string): store is Store {
  return store === "lowes" || store === "homedepot";
}

function buildRetailerUrl(store: Store, query: string, storeZip?: string): string {
  const url =
    store === "lowes"
      ? new URL("https://www.lowes.com/search")
      : new URL("https://www.homedepot.com/s");
  url.searchParams.set("q", query);
  if (storeZip) {
    url.searchParams.set("store_zip", storeZip);
  }
  return url.toString();
}

function toNumber(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === "string") {
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toBoolean(val: unknown): boolean | null {
  if (typeof val === "boolean") {
    return val;
  }
  if (typeof val === "string") {
    if (val.toLowerCase() === "true") {
      return true;
    }
    if (val.toLowerCase() === "false") {
      return false;
    }
  }
  return null;
}

function safeString(val: unknown): string | null {
  return typeof val === "string" && val.trim() ? val : null;
}

export function normalizeLowesResponse(payload: unknown): NormalizedProduct[] {
  const items: unknown[] =
    (payload as { products?: unknown[]; items?: unknown[] } | null)?.products ??
    (payload as { products?: unknown[]; items?: unknown[] } | null)?.items ??
    [];

  return items
    .map((raw) => {
      const obj = raw as Record<string, unknown>;
      const name = safeString(obj.name ?? obj.productTitle ?? obj.description) ?? "Unknown";
      const price =
        toNumber(
          obj.regularPrice ??
            obj.price ??
            (obj.pricing as Record<string, unknown> | undefined)?.regularPrice,
        ) ?? null;
      const unit = safeString(obj.unit ?? obj.uom ?? obj.unitOfMeasure) ?? "each";
      const sku = safeString(obj.sku ?? obj.itemId ?? obj.productId) ?? "";
      const availabilityType = obj.availabilityType ?? obj.availability ?? obj.stockStatus;
      const inStock =
        toBoolean(obj.inStock) ??
        (typeof availabilityType === "string"
          ? !/out[\s_]*of[\s_]*stock|unavailable|sold[\s_]*out/i.test(availabilityType)
          : true);

      if (price === null || sku === "") {
        return null;
      }

      return { name, price, unit, sku, inStock };
    })
    .filter((p): p is NormalizedProduct => p !== null);
}

export function normalizeHomeDepotResponse(payload: unknown): NormalizedProduct[] {
  const items: unknown[] =
    (payload as { products?: unknown[]; items?: unknown[] } | null)?.products ??
    (payload as { products?: unknown[]; items?: unknown[] } | null)?.items ??
    [];

  return items
    .map((raw) => {
      const obj = raw as Record<string, unknown>;
      const name = safeString(obj.name ?? obj.productLabel ?? obj.title) ?? "Unknown";
      const price = toNumber(obj.regularPrice ?? obj.price ?? obj.currentPrice) ?? null;
      const unit = safeString(obj.unit ?? obj.uom ?? obj.unitOfMeasure) ?? "each";
      const sku = safeString(obj.sku ?? obj.itemId ?? obj.productId) ?? "";
      const availabilityType = obj.availabilityType ?? obj.availability ?? obj.stockStatus;
      const inStock =
        toBoolean(obj.inStock) ??
        (typeof availabilityType === "string"
          ? !/out[\s_]*of[\s_]*stock|unavailable|sold[\s_]*out/i.test(availabilityType)
          : true);

      if (price === null || sku === "") {
        return null;
      }

      return { name, price, unit, sku, inStock };
    })
    .filter((p): p is NormalizedProduct => p !== null);
}

export type HandlerDeps = {
  fetchImpl?: typeof fetch;
  envGet?: (key: string) => string | undefined;
};

export async function handler(req: Request, deps: HandlerDeps = {}): Promise<Response> {
  const envGet =
    deps.envGet ??
    ((key: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const denoEnv = (globalThis as any)?.Deno?.env;
      if (!denoEnv?.get) {
        return undefined;
      }
      return denoEnv.get(key) as string | undefined;
    });
  const anonKey = envGet("SUPABASE_ANON_KEY");
  const authToken = parseBearerToken(req.headers.get("Authorization"));
  if (!authToken) {
    return jsonResponse(401, { error: "Unauthorized" });
  }
  if (!anonKey || authToken !== anonKey) {
    return jsonResponse(401, { error: "Unauthorized" });
  }

  let body: GetPriceRequestBody;
  try {
    body = (await req.json()) as GetPriceRequestBody;
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const storeRaw = typeof body.store === "string" ? body.store.toLowerCase() : "";
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const storeZip = typeof body.store_zip === "string" ? body.store_zip.trim() : undefined;

  if (!storeRaw) {
    return jsonResponse(400, { error: "Missing store" });
  }
  if (!isSupportedStore(storeRaw)) {
    return jsonResponse(400, { error: "Unknown store" });
  }
  if (!query) {
    return jsonResponse(400, { error: "Missing query" });
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = buildRetailerUrl(storeRaw, query, storeZip);

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse(502, { error: msg });
  }

  if (!upstream.ok) {
    return jsonResponse(502, { error: `Retailer returned ${upstream.status}` });
  }

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return jsonResponse(502, { error: "Invalid retailer response" });
  }

  const products =
    storeRaw === "lowes" ? normalizeLowesResponse(payload) : normalizeHomeDepotResponse(payload);

  return jsonResponse(200, { products });
}
