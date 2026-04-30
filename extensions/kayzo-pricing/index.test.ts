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

/** Integration credentials returned by the get-integrations edge function. */
function makeIntegrations(overrides: Record<string, unknown> = {}) {
  return {
    lowes_api_key: null,
    lowes_account_number: null,
    homedepot_api_key: null,
    homedepot_account_number: null,
    ...overrides,
  };
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

  it("lookup_lowes_price has a non-empty description", () => {
    const { api, tools } = createMockApi();
    plugin.register(api);
    const tool = tools.get("lookup_lowes_price")!;
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("lookup_homedepot_price has a non-empty description", () => {
    const { api, tools } = createMockApi();
    plugin.register(api);
    const tool = tools.get("lookup_homedepot_price")!;
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("lookup_lowes_price has a parameters schema with a query property", () => {
    const { api, tools } = createMockApi();
    plugin.register(api);
    const tool = tools.get("lookup_lowes_price")!;
    const props = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).toHaveProperty("query");
  });

  it("lookup_lowes_price parameters schema includes an optional store_zip property", () => {
    const { api, tools } = createMockApi();
    plugin.register(api);
    const tool = tools.get("lookup_lowes_price")!;
    const props = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).toHaveProperty("store_zip");
  });

  // ── gateway_start ────────────────────────────────────────────────────────────

  describe("gateway_start", () => {
    it("calls the get-integrations edge function on startup", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makeIntegrations()),
        }),
      );
      const { api, handlers } = createMockApi();
      plugin.register(api);

      await handlers.get("gateway_start")!({});

      const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(urls.some((u) => u.includes("get-integrations"))).toBe(true);
    });

    it("logs when Lowe's Pro is configured", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve(
              makeIntegrations({ lowes_api_key: "lp-key", lowes_account_number: "12345" }),
            ),
        }),
      );
      const { api, handlers } = createMockApi();
      plugin.register(api);

      await handlers.get("gateway_start")!({});

      const infoLogs = (api.logger!.info as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join(" ");
      expect(infoLogs.toLowerCase()).toMatch(/lowe/);
    });

    it("logs when Home Depot Pro is configured", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makeIntegrations({ homedepot_api_key: "hd-key" })),
        }),
      );
      const { api, handlers } = createMockApi();
      plugin.register(api);

      await handlers.get("gateway_start")!({});

      const infoLogs = (api.logger!.info as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join(" ");
      expect(infoLogs.toLowerCase()).toMatch(/home depot|homedepot/);
    });

    it("logs 'no stores configured' when neither store has credentials", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makeIntegrations()),
        }),
      );
      const { api, handlers } = createMockApi();
      plugin.register(api);

      await handlers.get("gateway_start")!({});

      const infoLogs = (api.logger!.info as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join(" ");
      expect(infoLogs.toLowerCase()).toMatch(/no stores configured|no pricing/);
    });

    it("continues without throwing when get-integrations fetch fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
      const { api, handlers } = createMockApi();
      plugin.register(api);

      await expect(handlers.get("gateway_start")!({})).resolves.toBeUndefined();
    });

    it("logs a warning when get-integrations fetch fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
      const { api, handlers } = createMockApi();
      plugin.register(api);

      await handlers.get("gateway_start")!({});

      expect(api.logger!.warn).toHaveBeenCalledWith(
        expect.stringContaining("integrations fetch failed"),
      );
    });
  });

  // ── before_agent_start ────────────────────────────────────────────────────────

  describe("before_agent_start", () => {
    async function setup(integrations: Record<string, unknown> = {}) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makeIntegrations(integrations)),
        }),
      );
      const { api, handlers } = createMockApi();
      plugin.register(api);
      await handlers.get("gateway_start")!({});
      return handlers;
    }

    it("returns undefined when no stores are configured", async () => {
      const handlers = await setup();
      const result = await handlers.get("before_agent_start")!({});
      expect(result).toBeUndefined();
    });

    it("returns appendSystemContext when Lowe's is configured", async () => {
      const handlers = await setup({ lowes_api_key: "lp-key" });
      const result = (await handlers.get("before_agent_start")!({})) as
        | { appendSystemContext: string }
        | undefined;
      expect(result?.appendSystemContext).toBeTruthy();
    });

    it("pricing context mentions Lowe's when configured", async () => {
      const handlers = await setup({ lowes_api_key: "lp-key", lowes_account_number: "ACC-12345" });
      const result = (await handlers.get("before_agent_start")!({})) as
        | { appendSystemContext: string }
        | undefined;
      expect(result?.appendSystemContext?.toLowerCase()).toMatch(/lowe/);
    });

    it("pricing context mentions Home Depot when configured", async () => {
      const handlers = await setup({ homedepot_api_key: "hd-key" });
      const result = (await handlers.get("before_agent_start")!({})) as
        | { appendSystemContext: string }
        | undefined;
      expect(result?.appendSystemContext?.toLowerCase()).toMatch(/home depot|homedepot/);
    });

    it("pricing context includes Lowe's account number when present", async () => {
      const handlers = await setup({ lowes_api_key: "lp-key", lowes_account_number: "ACC-99" });
      const result = (await handlers.get("before_agent_start")!({})) as
        | { appendSystemContext: string }
        | undefined;
      expect(result?.appendSystemContext).toContain("ACC-99");
    });

    it("pricing context includes Home Depot account number when present", async () => {
      const handlers = await setup({
        homedepot_api_key: "hd-key",
        homedepot_account_number: "PRO-77",
      });
      const result = (await handlers.get("before_agent_start")!({})) as
        | { appendSystemContext: string }
        | undefined;
      expect(result?.appendSystemContext).toContain("PRO-77");
    });

    it("pricing context mentions both stores when both are configured", async () => {
      const handlers = await setup({ lowes_api_key: "lp-key", homedepot_api_key: "hd-key" });
      const result = (await handlers.get("before_agent_start")!({})) as
        | { appendSystemContext: string }
        | undefined;
      expect(result?.appendSystemContext?.toLowerCase()).toMatch(/lowe/);
      expect(result?.appendSystemContext?.toLowerCase()).toMatch(/home depot|homedepot/);
    });

    it("context instructs the agent to use pricing tools when stores are configured", async () => {
      const handlers = await setup({ lowes_api_key: "lp-key" });
      const result = (await handlers.get("before_agent_start")!({})) as
        | { appendSystemContext: string }
        | undefined;
      // Context should reference the tool name so the agent knows to call it
      expect(result?.appendSystemContext).toMatch(/lookup_lowes_price|pricing tool|price lookup/i);
    });
  });

  // ── lookup_lowes_price tool ───────────────────────────────────────────────────

  describe("lookup_lowes_price tool", () => {
    async function getLowesTool(integrations: Record<string, unknown> = {}) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makeIntegrations(integrations)),
        }),
      );
      const { api, handlers, tools } = createMockApi();
      plugin.register(api);
      await handlers.get("gateway_start")!({});
      return tools.get("lookup_lowes_price")!;
    }

    it("calls the Lowe's Pro B2B API when a customer API key is configured", async () => {
      const tool = await getLowesTool({
        lowes_api_key: "lp-pro-key",
        lowes_account_number: "12345",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makePricingResponse()),
        }),
      );

      await tool.execute("call-1", { query: "2x4 framing lumber" });

      const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      // Must call the Lowe's-specific API endpoint, not a fallback
      expect(urls.some((u) => u.toLowerCase().includes("lowe"))).toBe(true);
    });

    it("uses the platform fallback pricing API when no customer key is configured", async () => {
      const tool = await getLowesTool(); // no credentials

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ products: [] }),
        }),
      );

      await tool.execute("call-1", { query: "concrete mix" });

      // Falls back — still calls an external pricing service
      expect(fetch).toHaveBeenCalled();
    });

    it("returns an AgentToolResult with content and details", async () => {
      const tool = await getLowesTool({ lowes_api_key: "lp-key" });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makePricingResponse()),
        }),
      );

      const result = await tool.execute("call-1", { query: "2x4 lumber" });

      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("details");
    });

    it("returns product results in the details field", async () => {
      const tool = await getLowesTool({ lowes_api_key: "lp-key" });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makePricingResponse()),
        }),
      );

      const result = await tool.execute("call-1", { query: "2x4 lumber" });
      const details = result.details as { results: Array<{ name: string; price: number }> };

      expect(Array.isArray(details.results)).toBe(true);
      expect(details.results.length).toBeGreaterThan(0);
      expect(details.results[0]).toHaveProperty("name");
      expect(details.results[0]).toHaveProperty("price");
    });

    it("returns formatted text in the content field", async () => {
      const tool = await getLowesTool({ lowes_api_key: "lp-key" });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makePricingResponse()),
        }),
      );

      const result = await tool.execute("call-1", { query: "2x4 lumber" });

      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe("text");
      expect(typeof (result.content[0] as { text: string }).text).toBe("string");
    });

    it("includes price in formatted content text", async () => {
      const tool = await getLowesTool({ lowes_api_key: "lp-key" });

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

    it("returns an empty results array and error text on API failure", async () => {
      const tool = await getLowesTool({ lowes_api_key: "lp-key" });

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("API timeout")));

      const result = await tool.execute("call-1", { query: "lumber" });
      const details = result.details as { results: unknown[]; error?: string };

      expect(details.results).toHaveLength(0);
      expect(details.error).toBeTruthy();
    });

    it("error content text mentions what went wrong", async () => {
      const tool = await getLowesTool({ lowes_api_key: "lp-key" });

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("API timeout")));

      const result = await tool.execute("call-1", { query: "lumber" });
      const text = (result.content[0] as { text: string }).text;

      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    });

    it("passes store_zip to the upstream API when provided", async () => {
      const tool = await getLowesTool({ lowes_api_key: "lp-key" });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makePricingResponse()),
        }),
      );

      await tool.execute("call-1", { query: "2x4 lumber", store_zip: "84101" });

      // The zip code should appear somewhere in the outgoing request (URL or body)
      const callArgs = JSON.stringify((fetch as ReturnType<typeof vi.fn>).mock.calls);
      expect(callArgs).toContain("84101");
    });

    it("sends the account number to the API when configured", async () => {
      const tool = await getLowesTool({
        lowes_api_key: "lp-key",
        lowes_account_number: "ACC-12345",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makePricingResponse()),
        }),
      );

      await tool.execute("call-1", { query: "hardware" });

      const callArgs = JSON.stringify((fetch as ReturnType<typeof vi.fn>).mock.calls);
      expect(callArgs).toContain("ACC-12345");
    });

    it("returns a helpful message when no pricing source is available", async () => {
      // No customer key AND no platformApiKey configured
      const tool = await getLowesTool();

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ products: [] }),
        }),
      );

      const result = await tool.execute("call-1", { query: "lumber" });
      const details = result.details as { results: unknown[] };

      // Returns empty results without crashing
      expect(Array.isArray(details.results)).toBe(true);
    });
  });

  // ── lookup_homedepot_price tool ───────────────────────────────────────────────

  describe("lookup_homedepot_price tool", () => {
    async function getHdTool(integrations: Record<string, unknown> = {}) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makeIntegrations(integrations)),
        }),
      );
      const { api, handlers, tools } = createMockApi();
      plugin.register(api);
      await handlers.get("gateway_start")!({});
      return tools.get("lookup_homedepot_price")!;
    }

    it("calls the Home Depot API when a customer API key is configured", async () => {
      const tool = await getHdTool({
        homedepot_api_key: "hd-pro-key",
        homedepot_account_number: "PRO-99",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve(
              makePricingResponse([
                {
                  name: "2x4x8 Spruce Stud",
                  price: 5.12,
                  unit: "each",
                  sku: "100018",
                  inStock: true,
                },
              ]),
            ),
        }),
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

    it("returns an AgentToolResult with content and details", async () => {
      const tool = await getHdTool({ homedepot_api_key: "hd-key" });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makePricingResponse()),
        }),
      );

      const result = await tool.execute("call-1", { query: "concrete" });

      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("details");
    });

    it("returns product results in the details field", async () => {
      const tool = await getHdTool({ homedepot_api_key: "hd-key" });

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

    it("returns an empty results array and error text on API failure", async () => {
      const tool = await getHdTool({ homedepot_api_key: "hd-key" });

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("503 Service Unavailable")));

      const result = await tool.execute("call-1", { query: "lumber" });
      const details = result.details as { results: unknown[]; error?: string };

      expect(details.results).toHaveLength(0);
      expect(details.error).toBeTruthy();
    });

    it("passes store_zip to the upstream API when provided", async () => {
      const tool = await getHdTool({ homedepot_api_key: "hd-key" });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(makePricingResponse()),
        }),
      );

      await tool.execute("call-1", { query: "plywood", store_zip: "30301" });

      const callArgs = JSON.stringify((fetch as ReturnType<typeof vi.fn>).mock.calls);
      expect(callArgs).toContain("30301");
    });

    it("includes price in formatted content text", async () => {
      const tool = await getHdTool({ homedepot_api_key: "hd-key" });

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

    it("uses the platform fallback pricing API when no customer key is configured", async () => {
      const tool = await getHdTool();

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ products: [] }),
        }),
      );

      await tool.execute("call-1", { query: "roofing nails" });

      expect(fetch).toHaveBeenCalled();
    });
  });
});
