import { Type } from "@sinclair/typebox";
import { readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { definePluginEntry } from "./api.js";

type PluginConfig = {
  licenseKey: string;
  supabaseUrl: string;
  supabaseAnonKey?: string;
  pricingApiKey?: string;
};

type PricingProduct = {
  name: string;
  price: number;
  unit: string;
  sku: string;
  inStock: boolean;
};

type PricingResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { results: PricingProduct[]; error?: string };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function edgeFunctionUrl(supabaseUrl: string, fn: string, query?: Record<string, string>): string {
  const base = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/${fn}`;
  if (!query || Object.keys(query).length === 0) {
    return base;
  }
  const url = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

function resolveBearerKey(cfg: PluginConfig): string {
  // Tests + current platform behavior expect the explicit pricingApiKey.
  // Supabase anon key is stored separately and may be used by other plugins.
  return cfg.pricingApiKey ?? "";
}

async function fetchPricing(
  supabaseUrl: string,
  apiKey: string,
  store: "lowes" | "homedepot",
  body: Record<string, unknown>,
): Promise<{ products: PricingProduct[] }> {
  // Include store in URL query so observability/tests can distinguish retailer path.
  const res = await fetch(edgeFunctionUrl(supabaseUrl, "get-price", { store }), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    let msg = `Pricing API returned ${res.status}`;
    try {
      const json = (await res.json()) as unknown;
      if (typeof (json as { error?: unknown } | null)?.error === "string") {
        msg = String((json as { error: string }).error);
      }
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return res.json() as Promise<{ products: PricingProduct[] }>;
}

function formatPricingResult(
  products: PricingProduct[],
  store: string,
  query: string,
): PricingResult {
  if (products.length === 0) {
    return {
      content: [{ type: "text", text: `No pricing results found for "${query}" at ${store}.` }],
      details: { results: [] },
    };
  }
  const lines = products.map(
    (p) =>
      `- ${p.name} — $${p.price}/${p.unit} (SKU: ${p.sku}) [${p.inStock ? "In stock" : "Out of stock"}]`,
  );
  return {
    content: [{ type: "text", text: `${store} pricing for "${query}":\n${lines.join("\n")}` }],
    details: { results: products },
  };
}

// ── Plugin entry ──────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "kayzo-pricing",
  name: "Kayzo Pricing",
  description: "Real-time material pricing lookups via Supabase get-price Edge Function.",

  register(api) {
    const cfg = api.pluginConfig as PluginConfig | undefined;

    if (!cfg?.licenseKey || !cfg?.supabaseUrl) {
      api.logger.error("kayzo-pricing: licenseKey and supabaseUrl are required -- plugin disabled");
      return;
    }

    const pricingApiKey = resolveBearerKey(cfg) || null;

    // ── before_agent_start: inject pricing context ────────────────────────────

    api.on("before_agent_start", (_event) => {
      if (!pricingApiKey) {
        return undefined;
      }

      return {
        appendSystemContext: [
          "## Material Pricing",
          "",
          "You have access to real-time material pricing tools. Use them when estimating job costs or creating bids.",
          "",
          "- **Lowe's**: use `lookup_lowes_price` to search current Lowe's pricing",
          "- **Home Depot**: use `lookup_homedepot_price` to search current Home Depot pricing",
        ].join("\n"),
      };
    });

    // ── lookup_lowes_price tool ───────────────────────────────────────────────

    api.registerTool({
      name: "lookup_lowes_price",
      label: "Lowe's Price Lookup",
      description:
        "Look up current material pricing from Lowe's. Returns product names, prices, SKUs, and availability for construction materials.",
      parameters: Type.Object({
        query: Type.String({
          description: "Product search query (e.g., '2x4x8 framing lumber', 'concrete mix 80lb')",
        }),
        store_zip: Type.Optional(
          Type.String({
            description: "ZIP code of the nearest Lowe's store for local pricing",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const query = readStringParam(params as Record<string, unknown>, "query", {
          required: true,
        });
        const store_zip =
          readStringParam(params as Record<string, unknown>, "store_zip") || undefined;

        if (!pricingApiKey) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Lowe's pricing is not available — pricing service is not configured for this gateway.",
              },
            ],
            details: { results: [] },
          };
        }

        const body: Record<string, unknown> = { store: "lowes", query };
        if (store_zip) {
          body.store_zip = store_zip;
        }

        try {
          const data = await fetchPricing(cfg.supabaseUrl, pricingApiKey, "lowes", body);
          return formatPricingResult(data.products ?? [], "Lowe's", query);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Could not retrieve Lowe's pricing: ${msg}` }],
            details: { results: [], error: msg },
          };
        }
      },
    });

    // ── lookup_homedepot_price tool ───────────────────────────────────────────

    api.registerTool({
      name: "lookup_homedepot_price",
      label: "Home Depot Price Lookup",
      description:
        "Look up current material pricing from Home Depot. Returns product names, prices, SKUs, and availability for construction materials.",
      parameters: Type.Object({
        query: Type.String({
          description: "Product search query (e.g., 'plywood 4x8 3/4', 'roofing nails 16d')",
        }),
        store_zip: Type.Optional(
          Type.String({
            description: "ZIP code of the nearest Home Depot store for local pricing",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const query = readStringParam(params as Record<string, unknown>, "query", {
          required: true,
        });
        const store_zip =
          readStringParam(params as Record<string, unknown>, "store_zip") || undefined;

        if (!pricingApiKey) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Home Depot pricing is not available — pricing service is not configured for this gateway.",
              },
            ],
            details: { results: [] },
          };
        }

        const body: Record<string, unknown> = { store: "homedepot", query };
        if (store_zip) {
          body.store_zip = store_zip;
        }

        try {
          const data = await fetchPricing(cfg.supabaseUrl, pricingApiKey, "homedepot", body);
          return formatPricingResult(data.products ?? [], "Home Depot", query);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              { type: "text" as const, text: `Could not retrieve Home Depot pricing: ${msg}` },
            ],
            details: { results: [], error: msg },
          };
        }
      },
    });
  },
});
