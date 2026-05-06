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
  url?: string;
};

export type GetPriceResponseBody = { products: NormalizedProduct[] } | { error: string };

const ALLOWED_ORIGIN = "https://app.kayzo.app";

function corsHeaders(origin: string | null): Record<string, string> {
  const allowOrigin = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(req: Request, status: number, body: GetPriceResponseBody): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(req.headers.get("Origin")),
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

function buildLowesRetailerUrl(query: string, storeZip?: string): string {
  // Note: Lowe's may block non-browser traffic from some edge networks.
  // We still target their public website JSON search endpoint (best effort).
  const url = new URL("https://www.lowes.com/search/api/v3_0/products");
  url.searchParams.set("searchTerm", query);
  if (storeZip) {
    // The actual parameter names vary; keep store_zip per Kayzo contract and pass zipCode too.
    url.searchParams.set("store_zip", storeZip);
    url.searchParams.set("zipCode", storeZip);
  }
  // Keep responses small and stable when supported.
  url.searchParams.set("page", "1");
  url.searchParams.set("maxResults", "24");
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
  const root = payload as Record<string, unknown> | null;
  const items: unknown[] =
    (root?.products as unknown[] | undefined) ??
    (root?.items as unknown[] | undefined) ??
    ((root?.data as Record<string, unknown> | undefined)?.items as unknown[] | undefined) ??
    [];

  return items
    .map((raw) => {
      const obj = raw as Record<string, unknown>;
      const name = safeString(obj.name ?? obj.productTitle ?? obj.description) ?? "Unknown";
      const price =
        toNumber(
          obj.regularPrice ??
            obj.price ??
            (obj.pricing as Record<string, unknown> | undefined)?.regularPrice ??
            (obj.pricing as Record<string, unknown> | undefined)?.value,
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

      const rawUrl = safeString(
        obj.productUrl ?? obj.canonicalUrl ?? obj.url ?? obj.seoUrl ?? obj.pdpUrl,
      );
      const url = rawUrl
        ? rawUrl.startsWith("http")
          ? rawUrl
          : `https://www.lowes.com${rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`}`
        : `https://www.lowes.com/search?searchTerm=${encodeURIComponent(sku)}`;

      return { name, price, unit, sku, inStock, url };
    })
    .filter((p): p is NormalizedProduct => p !== null);
}

export function normalizeHomeDepotResponse(payload: unknown): NormalizedProduct[] {
  // Home Depot website search uses a GraphQL response:
  // { data: { searchModel: { products: [...] } } }
  const root = payload as Record<string, unknown> | null;
  const data = (root?.data as Record<string, unknown> | undefined) ?? undefined;
  const searchModel = (data?.searchModel as Record<string, unknown> | undefined) ?? undefined;
  const items: unknown[] =
    (searchModel?.products as unknown[] | undefined) ??
    (root?.products as unknown[] | undefined) ??
    (root?.items as unknown[] | undefined) ??
    [];

  return items
    .map((raw) => {
      const obj = raw as Record<string, unknown>;
      const identifiers = (obj.identifiers as Record<string, unknown> | undefined) ?? undefined;
      const pricing = (obj.pricing as Record<string, unknown> | undefined) ?? undefined;
      const fulfillment = (obj.fulfillment as Record<string, unknown> | undefined) ?? undefined;
      const shipping = (fulfillment?.shipping as Record<string, unknown> | undefined) ?? undefined;

      const name =
        safeString(obj.name ?? identifiers?.productLabel ?? obj.productLabel ?? obj.title) ??
        "Unknown";
      const price =
        toNumber(pricing?.value ?? obj.regularPrice ?? obj.price ?? obj.currentPrice) ?? null;
      const unit = safeString(obj.unit ?? obj.uom ?? obj.unitOfMeasure) ?? "each";
      const sku = safeString(obj.sku ?? obj.itemId ?? obj.productId) ?? "";

      const inStock =
        toBoolean(shipping?.inStock) ??
        toBoolean(obj.inStock) ??
        (() => {
          const availabilityType = obj.availabilityType ?? obj.availability ?? obj.stockStatus;
          if (typeof availabilityType === "string") {
            return !/out[\s_]*of[\s_]*stock|unavailable|sold[\s_]*out/i.test(availabilityType);
          }
          return true;
        })();

      if (price === null || sku === "") {
        return null;
      }

      const rawUrl = safeString(obj.productUrl ?? obj.canonicalUrl ?? obj.url);
      const url = rawUrl
        ? rawUrl.startsWith("http")
          ? rawUrl
          : `https://www.homedepot.com${rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`}`
        : `https://www.homedepot.com/p/${sku}`;

      return { name, price, unit, sku, inStock, url };
    })
    .filter((p): p is NormalizedProduct => p !== null);
}

export type HandlerDeps = {
  fetchImpl?: typeof fetch;
  envGet?: (key: string) => string | undefined;
};

export async function handler(req: Request, deps: HandlerDeps = {}): Promise<Response> {
  if (req.method.toUpperCase() === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(req.headers.get("Origin")),
      },
    });
  }
  if (req.method.toUpperCase() !== "POST") {
    return jsonResponse(req, 405, { error: "Method not allowed" });
  }

  const envGet =
    deps.envGet ??
    ((key: string) => {
      const deno = globalThis as unknown as {
        Deno?: { env?: { get?: (k: string) => string | undefined } };
      };
      return deno.Deno?.env?.get?.(key);
    });
  const anonKey = envGet("SUPABASE_ANON_KEY");
  const authToken = parseBearerToken(req.headers.get("Authorization"));
  if (!authToken) {
    return jsonResponse(req, 401, { error: "Unauthorized" });
  }
  if (!anonKey || authToken !== anonKey) {
    return jsonResponse(req, 401, { error: "Unauthorized" });
  }

  let body: GetPriceRequestBody;
  try {
    body = (await req.json()) as GetPriceRequestBody;
  } catch {
    return jsonResponse(req, 400, { error: "Invalid JSON body" });
  }

  const storeRaw = typeof body.store === "string" ? body.store.toLowerCase() : "";
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const storeZip = typeof body.store_zip === "string" ? body.store_zip.trim() : undefined;

  if (!storeRaw) {
    return jsonResponse(req, 400, { error: "Missing store" });
  }
  if (!isSupportedStore(storeRaw)) {
    return jsonResponse(req, 400, { error: "Unknown store" });
  }
  if (!query) {
    return jsonResponse(req, 400, { error: "Missing query" });
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const url =
    storeRaw === "lowes"
      ? buildLowesRetailerUrl(query, storeZip)
      : "https://apionline.homedepot.com/federation-gateway/graphql?opname=searchModel";

  const upstreamInit: RequestInit =
    storeRaw === "lowes"
      ? {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0 (Kayzo; +https://app.kayzo.app)",
          },
        }
      : {
          method: "POST",
          headers: {
            Accept: "*/*",
            "Content-Type": "application/json",
            Origin: "https://www.homedepot.com",
            Referer: "https://www.homedepot.com/",
            "User-Agent": "Mozilla/5.0 (Kayzo; +https://app.kayzo.app)",
            "x-experience-name": "general-merchandise",
            "x-hd-dc": "origin",
            "x-debug": "false",
          },
          body: JSON.stringify({
            operationName: "searchModel",
            variables: {
              skipInstallServices: false,
              skipFavoriteCount: false,
              storefilter: "ALL",
              channel: "DESKTOP",
              skipDiscoveryZones: false,
              skipBuyitagain: true,
              additionalSearchParams: storeZip
                ? { deliveryZip: storeZip, multiStoreIds: [] as string[] }
                : { multiStoreIds: [] as string[] },
              filter: {},
              isBrandPricingPolicyCompliant: false,
              keyword: query,
              navParam: null,
              orderBy: { field: "BEST_MATCH", order: "ASC" },
              pageSize: 24,
              startIndex: 0,
              storeId: null,
            },
            query: `
query searchModel(
  $storeId: String,
  $startIndex: Int,
  $pageSize: Int,
  $orderBy: ProductSort,
  $filter: ProductFilter,
  $isBrandPricingPolicyCompliant: Boolean,
  $keyword: String,
  $navParam: String,
  $storefilter: StoreFilter = ALL,
  $channel: Channel = DESKTOP,
  $additionalSearchParams: AdditionalParams
) {
  searchModel(
    keyword: $keyword,
    navParam: $navParam,
    storefilter: $storefilter,
    isBrandPricingPolicyCompliant: $isBrandPricingPolicyCompliant,
    storeId: $storeId,
    channel: $channel,
    additionalSearchParams: $additionalSearchParams
  ) {
    products(startIndex: $startIndex, pageSize: $pageSize, orderBy: $orderBy, filter: $filter) {
      itemId
      identifiers {
        productLabel
      }
      pricing(storeId: $storeId, isBrandPricingPolicyCompliant: $isBrandPricingPolicyCompliant) {
        value
      }
      fulfillment {
        shipping {
          inStock
        }
      }
    }
  }
}
`,
          }),
        };

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, upstreamInit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse(req, 502, { error: msg });
  }

  if (!upstream.ok) {
    return jsonResponse(req, 502, { error: `Retailer returned ${upstream.status}` });
  }

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return jsonResponse(req, 502, { error: "Invalid retailer response" });
  }

  const products =
    storeRaw === "lowes" ? normalizeLowesResponse(payload) : normalizeHomeDepotResponse(payload);

  return jsonResponse(req, 200, { products });
}

// Supabase Edge Function entrypoint (guarded for Node-based unit tests)
const maybeDeno = globalThis as unknown as {
  Deno?: { serve?: (h: (req: Request) => Response | Promise<Response>) => void };
};
if (typeof maybeDeno.Deno?.serve === "function") {
  maybeDeno.Deno.serve((req) => handler(req));
}
