import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";

// Make definePluginEntry a pass-through so the default export is the raw definition object.
vi.mock("./api.js", () => ({
  definePluginEntry: (def: Record<string, unknown>) => def,
}));

// ── Types ─────────────────────────────────────────────────────────────────────

type EventHandler = (...args: unknown[]) => Promise<unknown> | unknown;

/** Minimal shape of a registered tool as the plugin will pass to api.registerTool. */
type ToolDef = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
};

type PluginDef = {
  id: string;
  name: string;
  description: string;
  register: (api: Partial<OpenClawPluginApi>) => void;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockApi(pluginConfig: Record<string, unknown> = {}) {
  const handlers = new Map<string, EventHandler>();
  const tools = new Map<string, ToolDef>();

  const api: Partial<OpenClawPluginApi> = {
    pluginConfig: {
      licenseKey: "test-license-key",
      supabaseUrl: "https://test.supabase.co",
      supabaseAnonKey: "test-anon-key",
      pricingApiKey: "kayzo-pricing-api-key",
      ...pluginConfig,
    },
    config: {
      agents: { defaults: { workspace: "/tmp/kayzo-pricing-test/workspace" } },
    } as unknown as OpenClawPluginApi["config"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as OpenClawPluginApi["logger"],
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    }) as unknown as OpenClawPluginApi["on"],
    registerTool: vi.fn((tool: ToolDef) => {
      tools.set(tool.name, tool);
    }) as unknown as OpenClawPluginApi["registerTool"],
    registerService: vi.fn() as unknown as OpenClawPluginApi["registerService"],
  };

  return { api, handlers, tools };
}

/** Simulate a successful product lookup API response. */
function makePricingResponse(
  products: Array<{
    name: string;
    price: number;
    unit: string;
    sku: string;
    inStock: boolean;
  }> = [],
) {
  return {
    products:
      products.length > 0
        ? products
        : [
            {
              name: "2x4x8 Douglas Fir",
              price: 4.98,
              unit: "each",
              sku: "1000012345",
              inStock: true,
            },
          ],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("kayzo-pricing plugin", () => {
  let plugin: PluginDef;

  beforeEach(async () => {
    vi.clearAllMocks();
    plugin = ((await import("./index.js")) as { default: PluginDef }).default;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Identity ─────────────────────────────────────────────────────────────────

  it("has the correct id", () => {
    expect(plugin.id).toBe("kayzo-pricing");
  });

  it("has the correct name", () => {
    expect(plugin.name).toBe("Kayzo Pricing");
  });

  it("has a non-empty description", () => {
    expect(typeof plugin.description).toBe("string");
    expect(plugin.description.length).toBeGreaterThan(0);
  });

  // ── Config validation ─────────────────────────────────────────────────────────

  it("logs an error and returns early when licenseKey is missing", () => {
    const { api } = createMockApi({ licenseKey: undefined });
    plugin.register(api);
    expect(api.logger!.error).toHaveBeenCalledWith(
      expect.stringContaining("licenseKey and supabaseUrl are required"),
    );
    expect(api.on).not.toHaveBeenCalled();
  });

  it("logs an error and returns early when supabaseUrl is missing", () => {
    const { api } = createMockApi({ supabaseUrl: undefined });
    plugin.register(api);
    expect(api.logger!.error).toHaveBeenCalledWith(
      expect.stringContaining("licenseKey and supabaseUrl are required"),
    );
    expect(api.on).not.toHaveBeenCalled();
  });

  it("does not register tools when config is invalid", () => {
    const { api } = createMockApi({ licenseKey: undefined });
    plugin.register(api);
    expect(api.registerTool).not.toHaveBeenCalled();
  });

  // ── Tool registration ────────────────────────────────────────────────────────

  it("registers lookup_lowes_price on register()", () => {
    const { api, tools } = createMockApi();
    plugin.register(api);
    expect(tools.has("lookup_lowes_price")).toBe(true);
  });

  it("registers lookup_homedepot_price on register()", () => {
    const { api, tools } = createMockApi();
    plugin.register(api);
    expect(tools.has("lookup_homedepot_price")).toBe(true);
  });

  it("registers exactly two tools", () => {
    const { api, tools } = createMockApi();
    plugin.register(api);
    expect(tools.size).toBe(2);
  });

  it("registers both tools even when pricingApiKey is not configured", () => {
    const { api, tools } = createMockApi({ pricingApiKey: undefined });
    plugin.register(api);
    expect(tools.size).toBe(2);
  });

  it("lookup_lowes_price has a non-empty description", () => {
    const { api, tools } = createMockApi();
    plugin.register(api);
    expect(tools.get("lookup_lowes_price")!.description.length).toBeGreaterThan(0);
  });

  it("lookup_homedepot_price has a non-empty description", () => {
    const { api, tools } = createMockApi();
    plugin.register(api);
    expect(tools.get("lookup_homedepot_price")!.description.length).toBeGreaterThan(0);
  });

  it("lookup_lowes_price parameters schema includes a query property", () => {
    const { api, tools } = createMockApi();
    plugin.register(api);
    const props =
      (tools.get("lookup_lowes_price")!.parameters as { properties?: Record<string, unknown> })
        .properties ?? {};
    expect(props).toHaveProperty("query");
  });

  it("lookup_lowes_price parameters schema includes an optional store_zip property", () => {
    const { api, tools } = createMockApi();
    plugin.register(api);
    const props =
      (tools.get("lookup_lowes_price")!.parameters as { properties?: Record<string, unknown> })
        .properties ?? {};
    expect(props).toHaveProperty("store_zip");
  });

  // ── before_agent_start ────────────────────────────────────────────────────────

  describe("before_agent_start", () => {
    it("returns appendSystemContext when pricingApiKey is configured", () => {
      const { api, handlers } = createMockApi();
      plugin.register(api);
      const result = handlers.get("before_agent_start")!({}) as
        | { appendSystemContext: string }
        | undefined;
      expect(result?.appendSystemContext).toBeTruthy();
    });

    it("returns undefined when pricingApiKey is not configured", () => {
      const { api, handlers } = createMockApi({ pricingApiKey: undefined });
      plugin.register(api);
      const result = handlers.get("before_agent_start")!({});
      expect(result).toBeUndefined();
    });

    it("pricing context mentions Lowe's", () => {
      const { api, handlers } = createMockApi();
      plugin.register(api);
      const result = handlers.get("before_agent_start")!({}) as { appendSystemContext: string };
      expect(result.appendSystemContext.toLowerCase()).toMatch(/lowe/);
    });

    it("pricing context mentions Home Depot", () => {
      const { api, handlers } = createMockApi();
      plugin.register(api);
      const result = handlers.get("before_agent_start")!({}) as { appendSystemContext: string };
      expect(result.appendSystemContext.toLowerCase()).toMatch(/home depot|homedepot/);
    });

    it("pricing context instructs the agent to use the pricing tools", () => {
      const { api, handlers } = createMockApi();
      plugin.register(api);
      const result = handlers.get("before_agent_start")!({}) as { appendSystemContext: string };
      expect(result.appendSystemContext).toMatch(
        /lookup_lowes_price|lookup_homedepot_price|pricing tool/i,
      );
    });
  });

  // ── lookup_lowes_price tool ───────────────────────────────────────────────────

  describe("lookup_lowes_price tool", () => {
    function getLowesTool(pluginConfig: Record<string, unknown> = {}) {
      const { api, tools } = createMockApi(pluginConfig);
      plugin.register(api);
      return tools.get("lookup_lowes_price")!;
    }

    it("calls a Lowe's pricing endpoint", async () => {
      const tool = getLowesTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makePricingResponse()) }),
      );

      await tool.execute("call-1", { query: "2x4 framing lumber" });

      const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(urls.some((u) => u.toLowerCase().includes("lowe"))).toBe(true);
    });

    it("sends the pricingApiKey in the request", async () => {
      const tool = getLowesTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makePricingResponse()) }),
      );

      await tool.execute("call-1", { query: "lumber" });

      const callArgs = JSON.stringify((fetch as ReturnType<typeof vi.fn>).mock.calls);
      expect(callArgs).toContain("kayzo-pricing-api-key");
    });

    it("does not send customer-specific credentials in the request", async () => {
      const tool = getLowesTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makePricingResponse()) }),
      );

      await tool.execute("call-1", { query: "lumber" });

      const callArgs = JSON.stringify((fetch as ReturnType<typeof vi.fn>).mock.calls);
      expect(callArgs).not.toContain("lowes_api_key");
      expect(callArgs).not.toContain("account_number");
    });

    it("returns an AgentToolResult with content and details", async () => {
      const tool = getLowesTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makePricingResponse()) }),
      );

      const result = await tool.execute("call-1", { query: "2x4 lumber" });

      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("details");
    });

    it("returns product results in the details field", async () => {
      const tool = getLowesTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makePricingResponse()) }),
      );

      const result = await tool.execute("call-1", { query: "2x4 lumber" });
      const details = result.details as { results: Array<{ name: string; price: number }> };

      expect(Array.isArray(details.results)).toBe(true);
      expect(details.results.length).toBeGreaterThan(0);
      expect(details.results[0]).toHaveProperty("name");
      expect(details.results[0]).toHaveProperty("price");
    });

    it("returns formatted text in the content field", async () => {
      const tool = getLowesTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makePricingResponse()) }),
      );

      const result = await tool.execute("call-1", { query: "2x4 lumber" });

      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe("text");
      expect(typeof (result.content[0] as { text: string }).text).toBe("string");
    });

    it("includes price in formatted content text", async () => {
      const tool = getLowesTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve(
              makePricingResponse([
                {
                  name: "2x4x8 Douglas Fir",
                  price: 4.98,
                  unit: "each",
                  sku: "1000012345",
                  inStock: true,
                },
              ]),
            ),
        }),
      );

      const result = await tool.execute("call-1", { query: "framing lumber" });
      const text = (result.content[0] as { text: string }).text;

      expect(text).toContain("4.98");
    });

    it("passes store_zip to the upstream API when provided", async () => {
      const tool = getLowesTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makePricingResponse()) }),
      );

      await tool.execute("call-1", { query: "2x4 lumber", store_zip: "84101" });

      const callArgs = JSON.stringify((fetch as ReturnType<typeof vi.fn>).mock.calls);
      expect(callArgs).toContain("84101");
    });

    it("returns an empty results array and error text on API failure", async () => {
      const tool = getLowesTool();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("API timeout")));

      const result = await tool.execute("call-1", { query: "lumber" });
      const details = result.details as { results: unknown[]; error?: string };

      expect(details.results).toHaveLength(0);
      expect(details.error).toBeTruthy();
    });

    it("error content text describes the failure", async () => {
      const tool = getLowesTool();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("API timeout")));

      const result = await tool.execute("call-1", { query: "lumber" });
      const text = (result.content[0] as { text: string }).text;

      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    });

    it("returns a graceful response when pricingApiKey is not configured", async () => {
      const tool = getLowesTool({ pricingApiKey: undefined });

      const result = await tool.execute("call-1", { query: "lumber" });
      const details = result.details as { results: unknown[] };

      expect(Array.isArray(details.results)).toBe(true);
      expect(result.content[0].type).toBe("text");
    });

    it("does not call fetch when pricingApiKey is not configured", async () => {
      const tool = getLowesTool({ pricingApiKey: undefined });
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      await tool.execute("call-1", { query: "lumber" });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── lookup_homedepot_price tool ───────────────────────────────────────────────

  describe("lookup_homedepot_price tool", () => {
    function getHdTool(pluginConfig: Record<string, unknown> = {}) {
      const { api, tools } = createMockApi(pluginConfig);
      plugin.register(api);
      return tools.get("lookup_homedepot_price")!;
    }

    it("calls a Home Depot pricing endpoint", async () => {
      const tool = getHdTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makePricingResponse()) }),
      );

      await tool.execute("call-1", { query: "framing studs" });

      const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(
        urls.some(
          (u) => u.toLowerCase().includes("depot") || u.toLowerCase().includes("homedepot"),
        ),
      ).toBe(true);
    });

    it("sends the pricingApiKey in the request", async () => {
      const tool = getHdTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makePricingResponse()) }),
      );

      await tool.execute("call-1", { query: "plywood" });

      const callArgs = JSON.stringify((fetch as ReturnType<typeof vi.fn>).mock.calls);
      expect(callArgs).toContain("kayzo-pricing-api-key");
    });

    it("does not send customer-specific credentials in the request", async () => {
      const tool = getHdTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makePricingResponse()) }),
      );

      await tool.execute("call-1", { query: "plywood" });

      const callArgs = JSON.stringify((fetch as ReturnType<typeof vi.fn>).mock.calls);
      expect(callArgs).not.toContain("homedepot_api_key");
      expect(callArgs).not.toContain("account_number");
    });

    it("returns an AgentToolResult with content and details", async () => {
      const tool = getHdTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makePricingResponse()) }),
      );

      const result = await tool.execute("call-1", { query: "concrete" });

      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("details");
    });

    it("returns product results in the details field", async () => {
      const tool = getHdTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve(
              makePricingResponse([
                {
                  name: "Quickrete 80lb",
                  price: 8.27,
                  unit: "bag",
                  sku: "110111100",
                  inStock: true,
                },
              ]),
            ),
        }),
      );

      const result = await tool.execute("call-1", { query: "concrete" });
      const details = result.details as { results: Array<{ name: string; price: number }> };

      expect(Array.isArray(details.results)).toBe(true);
      expect(details.results[0]).toHaveProperty("name");
      expect(details.results[0]).toHaveProperty("price");
    });

    it("includes price in formatted content text", async () => {
      const tool = getHdTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve(
              makePricingResponse([
                {
                  name: "Quickrete 80lb",
                  price: 8.27,
                  unit: "bag",
                  sku: "110111100",
                  inStock: true,
                },
              ]),
            ),
        }),
      );

      const result = await tool.execute("call-1", { query: "concrete" });
      const text = (result.content[0] as { text: string }).text;

      expect(text).toContain("8.27");
    });

    it("passes store_zip to the upstream API when provided", async () => {
      const tool = getHdTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makePricingResponse()) }),
      );

      await tool.execute("call-1", { query: "plywood", store_zip: "30301" });

      const callArgs = JSON.stringify((fetch as ReturnType<typeof vi.fn>).mock.calls);
      expect(callArgs).toContain("30301");
    });

    it("returns an empty results array and error text on API failure", async () => {
      const tool = getHdTool();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("503 Service Unavailable")));

      const result = await tool.execute("call-1", { query: "lumber" });
      const details = result.details as { results: unknown[]; error?: string };

      expect(details.results).toHaveLength(0);
      expect(details.error).toBeTruthy();
    });

    it("does not include Lowe's fields in the Home Depot request", async () => {
      const tool = getHdTool();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makePricingResponse()) }),
      );

      await tool.execute("call-1", { query: "plywood" });

      const callArgs = JSON.stringify((fetch as ReturnType<typeof vi.fn>).mock.calls);
      expect(callArgs).not.toContain("lowes_api_key");
      expect(callArgs).not.toContain("lowes_account");
    });

    it("returns a graceful response when pricingApiKey is not configured", async () => {
      const tool = getHdTool({ pricingApiKey: undefined });

      const result = await tool.execute("call-1", { query: "roofing nails" });
      const details = result.details as { results: unknown[] };

      expect(Array.isArray(details.results)).toBe(true);
      expect(result.content[0].type).toBe("text");
    });
  });
});
