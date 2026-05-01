import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "./api.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type PluginConfig = {
  licenseKey: string;
  supabaseUrl: string;
  supabaseAnonKey?: string;
};

type Integrations = {
  lowes_api_key: string | null;
  lowes_account_number: string | null;
  homedepot_api_key: string | null;
  homedepot_account_number: string | null;
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

function edgeFunctionUrl(supabaseUrl: string, fn: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/functions/v1/${fn}`;
}

async function fetchPricing(
  url: string,
  apiKey: string | null,
  body: Record<string, unknown>,
): Promise<{ products: PricingProduct[] }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
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
    "Real-time material pricing lookups from Lowe's Pro and Home Depot Pro for Kayzo contractors.",

  register(api) {
    const cfg = api.pluginConfig as PluginConfig | undefined;

    if (!cfg?.licenseKey || !cfg?.supabaseUrl) {
      api.logger.error(
        "kayzo-pricing: licenseKey and supabaseUrl are required in plugin config -- plugin disabled",
      );
      return;
    }

    const { licenseKey, supabaseUrl } = cfg;
    const anonKey = cfg.supabaseAnonKey ?? "";

    // In-memory integrations loaded at gateway_start from Supabase edge function
    let integrations: Integrations = {
      lowes_api_key: null,
      lowes_account_number: null,
      homedepot_api_key: null,
      homedepot_account_number: null,
    };

    // ── gateway_start: fetch integration credentials ───────────────────────────

    api.on("gateway_start", async (_event) => {
      try {
        const res = await fetch(edgeFunctionUrl(supabaseUrl, "get-integrations"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${anonKey}`,
          },
          body: JSON.stringify({ license_key: licenseKey }),
          signal: AbortSignal.timeout(10_000),
        });

        if (res.ok) {
          integrations = (await res.json()) as Integrations;
        }

        const hasLowes = !!(integrations.lowes_api_key || integrations.lowes_account_number);
        const hasHD = !!(integrations.homedepot_api_key || integrations.homedepot_account_number);

        if (hasLowes) {
          api.logger.info("kayzo-pricing: Lowe's Pro integration configured");
        }
        if (hasHD) {
          api.logger.info("kayzo-pricing: Home Depot Pro integration configured");
        }
        if (!hasLowes && !hasHD) {
          api.logger.info("kayzo-pricing: no stores configured for pricing lookups");
        }
      } catch (err) {
        api.logger.warn(
          `kayzo-pricing: integrations fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    // ── before_agent_start: inject pricing context ────────────────────────────

    api.on("before_agent_start", (_event) => {
      const hasLowes = !!(integrations.lowes_api_key || integrations.lowes_account_number);
      const hasHD = !!(integrations.homedepot_api_key || integrations.homedepot_account_number);

      if (!hasLowes && !hasHD) {
        return undefined;
      }

      const lines = [
        "## Material Pricing",
        "",
        "You have access to real-time material pricing tools. Use them when estimating job costs or creating bids.",
        "",
      ];

      if (hasLowes) {
        const acct = integrations.lowes_account_number
          ? ` (account: ${integrations.lowes_account_number})`
          : "";
        lines.push(
          `- **Lowe's Pro${acct}**: use \`lookup_lowes_price\` to search Lowe's current pricing`,
        );
      }
      if (hasHD) {
        const acct = integrations.homedepot_account_number
          ? ` (account: ${integrations.homedepot_account_number})`
          : "";
        lines.push(
          `- **Home Depot Pro${acct}**: use \`lookup_homedepot_price\` to search Home Depot pricing`,
        );
      }

      return { appendSystemContext: lines.join("\n") };
    });

    // ── lookup_lowes_price tool ───────────────────────────────────────────────

    api.registerTool({
      name: "lookup_lowes_price",
      label: "Lowe's Price Lookup",
      description:
        "Look up current material pricing from Lowe's Pro. Returns product names, prices, SKUs, and availability for construction materials.",
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

        const body: Record<string, unknown> = { query };
        if (store_zip) {
          body.store_zip = store_zip;
        }
        if (integrations.lowes_account_number) {
          body.account_number = integrations.lowes_account_number;
        }

        const apiKey = integrations.lowes_api_key;
        const url = "https://developer.lowes.com/api/search/products";

        try {
          const data = await fetchPricing(url, apiKey, body);
          return formatPricingResult(data.products ?? [], "Lowe's", query);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Could not retrieve Lowe's pricing: ${msg}` }],
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
        "Look up current material pricing from Home Depot Pro. Returns product names, prices, SKUs, and availability for construction materials.",
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

        const body: Record<string, unknown> = { query };
        if (store_zip) {
          body.store_zip = store_zip;
        }
        if (integrations.homedepot_account_number) {
          body.account_number = integrations.homedepot_account_number;
        }

        const apiKey = integrations.homedepot_api_key;
        const url = "https://developer.homedepot.com/api/search/products";

        try {
          const data = await fetchPricing(url, apiKey, body);
          return formatPricingResult(data.products ?? [], "Home Depot", query);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Could not retrieve Home Depot pricing: ${msg}` }],
            details: { results: [], error: msg },
          };
        }
      },
    });
  },
});
