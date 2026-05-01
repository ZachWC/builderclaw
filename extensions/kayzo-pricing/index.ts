import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

type Store = "lowes" | "homedepot";

type PluginConfig = {
  supabaseUrl: string;
  supabaseAnonKey?: string;
  pricingApiKey?: string;
};

type GetPriceResponse =
  | {
      products: Array<{
        name: string;
        price: number;
        unit: string;
        sku: string;
        inStock: boolean;
      }>;
    }
  | { error: string };

function edgeFunctionUrl(supabaseUrl: string, fn: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/functions/v1/${fn}`;
}

function resolveBearerKey(cfg: PluginConfig): string {
  return cfg.pricingApiKey ?? cfg.supabaseAnonKey ?? "";
}

async function callGetPrice(params: {
  cfg: PluginConfig;
  store: Store;
  query: string;
  storeZip?: string;
}): Promise<GetPriceResponse> {
  const bearer = resolveBearerKey(params.cfg);
  if (!bearer) {
    return { error: "Missing Supabase anon key (supabaseAnonKey/pricingApiKey) in plugin config" };
  }
  const res = await fetch(edgeFunctionUrl(params.cfg.supabaseUrl, "get-price"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      store: params.store,
      query: params.query,
      store_zip: params.storeZip,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg =
      typeof (json as { error?: unknown } | null)?.error === "string"
        ? String((json as { error: string }).error)
        : `get-price returned ${res.status}`;
    return { error: msg };
  }
  return (json ?? { error: "Invalid get-price response" }) as GetPriceResponse;
}

const PricingToolSchema = Type.Object(
  {
    query: Type.String({ description: "Product search query, e.g. '2x4x8 framing lumber'." }),
    store_zip: Type.Optional(
      Type.String({
        description: "Optional ZIP code to localize availability/pricing when supported.",
      }),
    ),
  },
  { additionalProperties: false },
);

function createPricingTool(api: OpenClawPluginApi, store: Store) {
  const toolName = store === "lowes" ? "lowes_get_price" : "homedepot_get_price";
  const label = store === "lowes" ? "Lowe's Price Lookup" : "Home Depot Price Lookup";
  return {
    name: toolName,
    label,
    description:
      "Search products and retrieve normalized pricing via Kayzo's centralized Supabase get-price Edge Function.",
    parameters: PricingToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const query = readStringParam(rawParams, "query", { required: true });
      const storeZip = readStringParam(rawParams, "store_zip") || undefined;
      const cfg = api.pluginConfig as PluginConfig | undefined;
      if (!cfg?.supabaseUrl) {
        return jsonResult({ error: "kayzo-pricing: supabaseUrl is required in plugin config" });
      }
      return jsonResult(
        await callGetPrice({
          cfg,
          store,
          query,
          storeZip,
        }),
      );
    },
  };
}

export default definePluginEntry({
  id: "kayzo-pricing",
  name: "Kayzo Pricing",
  description: "Centralized pricing tools via Supabase Edge Function get-price.",
  register(api) {
    const cfg = api.pluginConfig as PluginConfig | undefined;
    if (!cfg?.supabaseUrl) {
      api.logger.error(
        "kayzo-pricing: supabaseUrl is required in plugin config -- plugin disabled",
      );
      return;
    }

    api.registerTool(createPricingTool(api, "lowes"));
    api.registerTool(createPricingTool(api, "homedepot"));
  },
});
