import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";

// Make definePluginEntry a pass-through so the default export is the raw definition object
vi.mock("./api.js", () => ({
  definePluginEntry: (def: Record<string, unknown>) => def,
}));

// Mock node:fs/promises so no real disk I/O happens.
// The plugin uses `import fs from "node:fs/promises"` (default import), so the factory
// must provide a `default` export alongside the named exports so the default import resolves.
vi.mock("node:fs/promises", () => {
  const mod = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("## Contractor Preferences\n- Ordering: {ORDERING_MODE}"),
    appendFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
  return { default: mod, ...mod };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

type EventHandler = (...args: unknown[]) => Promise<unknown> | unknown;
type ServiceDef = { id: string; start: () => void; stop: () => void };
type PluginDef = {
  id: string;
  name: string;
  description: string;
  register: (api: Partial<OpenClawPluginApi>) => void;
};

function makeLicense(overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    tier: "pro",
    status: "active",
    freeAccount: false,
    gatewayType: "cloud",
    gatewayUrl: null,
    overBudget: false,
    tokensUsed: 0,
    tokenBudget: 100_000,
    ...overrides,
  };
}

function makePreferences(): {
  ordering: { mode: string; threshold: number | null };
  scheduling: { mode: string; threshold: number | null };
  emailReplies: { mode: string };
  flagging: { mode: string };
  bidMarkup: number;
} {
  return {
    ordering: { mode: "threshold", threshold: 200 },
    scheduling: { mode: "always_ask", threshold: null },
    emailReplies: { mode: "always_ask" },
    flagging: { mode: "always_act" },
    bidMarkup: 20,
  };
}

function createMockApi(pluginConfig: Record<string, unknown> = {}) {
  const handlers = new Map<string, EventHandler>();
  let registeredService: ServiceDef | null = null;

  const api: Partial<OpenClawPluginApi> = {
    pluginConfig: {
      licenseKey: "test-license-key",
      supabaseUrl: "https://test.supabase.co",
      supabaseAnonKey: "test-anon-key",
      customerSlug: "testcustomer",
      ...pluginConfig,
    },
    config: {
      agents: { defaults: { workspace: "/tmp/kayzo-test/workspace" } },
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
    registerService: vi.fn((svc: ServiceDef) => {
      registeredService = svc;
    }) as unknown as OpenClawPluginApi["registerService"],
  };

  return {
    api,
    handlers,
    getService: () => registeredService,
  };
}

function mockFetchResponses(license: unknown, preferences: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      const body =
        typeof url === "string" && url.includes("validate-license") ? license : preferences;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      });
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("kayzo-license plugin", () => {
  let plugin: PluginDef;

  beforeEach(async () => {
    // Reset readFile to the default minimal template in case a previous describe block's
    // inner beforeEach (e.g., email enforcement) changed it to a different template.
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockResolvedValue(
      "## Contractor Preferences\n- Ordering: {ORDERING_MODE}",
    );
    plugin = ((await import("./index.js")) as { default: PluginDef }).default;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has the correct id, name, and description", () => {
    expect(plugin.id).toBe("kayzo-license");
    expect(plugin.name).toBe("Kayzo License");
    expect(typeof plugin.description).toBe("string");
  });

  it("logs an error and returns early when licenseKey is missing", () => {
    const { api } = createMockApi({ licenseKey: undefined });
    plugin.register(api);
    expect(api.logger!.error).toHaveBeenCalledWith(
      expect.stringContaining("licenseKey and supabaseUrl are required"),
    );
    expect(api.on).not.toHaveBeenCalled();
  });

  it("logs an error and returns early when supabaseUrl is missing", () => {
    const { api } = createMockApi({ licenseKey: "key", supabaseUrl: undefined });
    plugin.register(api);
    expect(api.logger!.error).toHaveBeenCalledWith(
      expect.stringContaining("licenseKey and supabaseUrl are required"),
    );
  });

  describe("gateway_start", () => {
    it("calls validate-license and get-preferences on startup", async () => {
      mockFetchResponses(makeLicense(), makePreferences());
      const { api, handlers } = createMockApi();
      plugin.register(api);

      await handlers.get("gateway_start")!({});

      // 2 edge-function calls + 1 fire-and-forget version PATCH
      expect(fetch).toHaveBeenCalledTimes(3);
      const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(urls.some((u) => u.includes("validate-license"))).toBe(true);
      expect(urls.some((u) => u.includes("get-preferences"))).toBe(true);
    });

    it("logs a warning when the customer is over budget", async () => {
      mockFetchResponses(
        makeLicense({ overBudget: true, tokensUsed: 100_001, tokenBudget: 100_000 }),
        makePreferences(),
      );
      const { api, handlers } = createMockApi();
      plugin.register(api);

      await handlers.get("gateway_start")!({});

      expect(api.logger!.warn).toHaveBeenCalledWith(
        expect.stringContaining("monthly token budget exceeded"),
      );
    });

    it("falls back to license cache when fetch fails", async () => {
      const fs = await import("node:fs/promises");
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify({ valid: true, cachedAt: new Date().toISOString() }),
      );
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
      const { api, handlers } = createMockApi();
      plugin.register(api);

      await handlers.get("gateway_start")!({});

      expect(api.logger!.warn).toHaveBeenCalledWith(
        expect.stringContaining("using cached license"),
      );
    });
  });

  describe("before_agent_start — budget enforcement", () => {
    async function setupWithLicense(licenseOverrides: Record<string, unknown> = {}) {
      mockFetchResponses(makeLicense(licenseOverrides), makePreferences());
      const { api, handlers } = createMockApi();
      plugin.register(api);
      // Prime cachedLicense by running gateway_start
      await handlers.get("gateway_start")!({});
      vi.mocked(fetch).mockClear();
      return handlers;
    }

    it("returns preferences context when under budget", async () => {
      const handlers = await setupWithLicense({ tokensUsed: 50_000, tokenBudget: 100_000 });
      const result = (await handlers.get("before_agent_start")!({})) as
        | { appendSystemContext: string }
        | undefined;
      // Should return something (preferences context) — not throw
      expect(result).toBeDefined();
    });

    it("throws when the customer is at or over their token budget", async () => {
      const handlers = await setupWithLicense({
        tokensUsed: 100_000,
        tokenBudget: 100_000,
        freeAccount: false,
      });
      await expect(handlers.get("before_agent_start")!({})).rejects.toThrow(
        /Monthly token budget exceeded/,
      );
    });

    it("does not block free accounts even when over budget", async () => {
      const handlers = await setupWithLicense({
        tokensUsed: 999_999,
        tokenBudget: 100_000,
        freeAccount: true,
      });
      // Should NOT throw for free accounts
      await expect(handlers.get("before_agent_start")!({})).resolves.not.toThrow();
    });

    it("does not block when tokenBudget is 0 (unlimited)", async () => {
      const handlers = await setupWithLicense({
        tokensUsed: 999_999,
        tokenBudget: 0,
        freeAccount: false,
      });
      await expect(handlers.get("before_agent_start")!({})).resolves.not.toThrow();
    });
  });

  describe("llm_output + agent_end — token tracking", () => {
    it("accumulates tokens across llm_output events and logs usage on agent_end", async () => {
      mockFetchResponses(makeLicense(), makePreferences());
      const { api, handlers } = createMockApi();
      plugin.register(api);
      await handlers.get("gateway_start")!({});

      // Simulate two llm_output events for the same run
      handlers.get("llm_output")!({ runId: "run-1", usage: { input: 500, output: 200 } });
      handlers.get("llm_output")!({ runId: "run-1", usage: { input: 100, output: 50 } });

      // Fetch is now only for usage log — reset the mock
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      );

      handlers.get("agent_end")!({});

      // Wait for the fire-and-forget usage log to settle
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledOnce();
      });

      const body = JSON.parse(
        (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
      ) as { input_tokens: number; output_tokens: number };
      expect(body.input_tokens).toBe(600);
      expect(body.output_tokens).toBe(250);
    });

    it("does not call log-usage when no tokens were accumulated", () => {
      mockFetchResponses(makeLicense(), makePreferences());
      const { handlers } = createMockApi();
      plugin.register({ ...createMockApi().api } as Partial<OpenClawPluginApi>);

      vi.stubGlobal("fetch", vi.fn());
      handlers.get("agent_end")?.({});

      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe("email approval enforcement", () => {
    // A complete PREFERENCES.md template that includes all placeholders.
    // Defined here (not in the vi.mock factory) to avoid TDZ issues.
    const PREFS_TEMPLATE = [
      "## Autonomy settings",
      "Ordering: {ORDERING_MODE} {ORDERING_THRESHOLD_TEXT}",
      "Scheduling: {SCHEDULING_MODE}",
      "Email replies (outbound): {EMAIL_REPLIES_MODE}",
      "Flagging: {FLAGGING_MODE}",
      "Bid markup: {MARKUP_PERCENTAGE}%",
    ].join("\n");

    // Override readFile in this describe block so the email placeholder is present.
    // Runs AFTER the outer vi.clearAllMocks() so the implementation is always fresh.
    beforeEach(async () => {
      const fs = await import("node:fs/promises");
      vi.mocked(fs.readFile).mockResolvedValue(PREFS_TEMPLATE);
    });

    async function getPreferencesContext(
      prefs: ReturnType<typeof makePreferences>,
    ): Promise<string> {
      mockFetchResponses(makeLicense(), prefs);
      const { api, handlers } = createMockApi();
      plugin.register(api);
      await handlers.get("gateway_start")!({});

      const result = (await handlers.get("before_agent_start")!({})) as
        | { appendSystemContext: string }
        | undefined;
      return result?.appendSystemContext ?? "";
    }

    it("never instructs the agent to send emails autonomously when mode is always_ask", async () => {
      const context = await getPreferencesContext(makePreferences());
      expect(context.length).toBeGreaterThan(0);
      // always_ask appears in the context (not overridden)
      expect(context).toContain("always_ask");
    });

    it("routes email replies to approval queue even when mode is always_act", async () => {
      const context = await getPreferencesContext({
        ...makePreferences(),
        emailReplies: { mode: "always_act" },
      });
      const emailLine = context.split("\n").find((line) => line.toLowerCase().includes("email"));
      expect(emailLine).toBeDefined();
      // The email_replies line must say always_ask regardless of the configured mode
      expect(emailLine).toContain("always_ask");
      expect(emailLine).not.toContain("always_act");
    });

    it("preserves always_act for non-email categories when email is always_act", async () => {
      const context = await getPreferencesContext({
        ...makePreferences(),
        ordering: { mode: "always_act", threshold: null },
        emailReplies: { mode: "always_act" },
      });
      const lines = context.split("\n");
      const orderingLine = lines.find((l) => l.toLowerCase().includes("ordering"));
      const emailLine = lines.find((l) => l.toLowerCase().includes("email"));

      // Email is always overridden to always_ask
      expect(emailLine).toBeDefined();
      expect(emailLine).not.toContain("always_act");
      expect(emailLine).toContain("always_ask");
      // Ordering is not subject to the email override
      expect(orderingLine).toContain("always_act");
    });

    it("before_agent_start always returns a non-empty preferences context", async () => {
      const context = await getPreferencesContext(makePreferences());
      expect(context.length).toBeGreaterThan(0);
      expect(context.toLowerCase()).toContain("email");
    });
  });
});
