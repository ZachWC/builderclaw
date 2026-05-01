import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "./api.js";

// ── Types ─────────────────────────────────────────────────────────────────────

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

async function fetchPricing(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ products: PricingProduct[] }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Pricing API returned ${res.status}`);
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
  description:
    "Real-time material pricing lookups from Lowe's and Home Depot for Kayzo contractors.",

  register(api) {
    const cfg = api.pluginConfig as PluginConfig | undefined;

    if (!cfg?.licenseKey || !cfg?.supabaseUrl) {
      api.logger.error(
        "kayzo-pricing: licenseKey and supabaseUrl are required in plugin config -- plugin disabled",
      );
      return;
    }

    const pricingApiKey = cfg.pricingApiKey ?? null;

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
        const { query, store_zip } = params as { query: string; store_zip?: string };

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

        const body: Record<string, unknown> = { query };
        if (store_zip) {
          body.store_zip = store_zip;
        }

        try {
          const data = await fetchPricing(
            "https://developer.lowes.com/api/search/products",
            pricingApiKey,
            body,
          );
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
        const { query, store_zip } = params as { query: string; store_zip?: string };

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

        const body: Record<string, unknown> = { query };
        if (store_zip) {
          body.store_zip = store_zip;
        }

        try {
          const data = await fetchPricing(
            "https://developer.homedepot.com/api/search/products",
            pricingApiKey,
            body,
          );
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
