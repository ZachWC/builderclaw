import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";

vi.mock("./api.js", () => ({
  definePluginEntry: (def: Record<string, unknown>) => def,
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

type EventHandler = (...args: unknown[]) => Promise<unknown> | unknown;
type ServiceDef = { id: string; start: () => void; stop: () => void };
type PluginDef = {
  id: string;
  name: string;
  register: (api: Partial<OpenClawPluginApi>) => void;
};

function createMockApi(pluginConfig: Record<string, unknown> = {}) {
  const handlers = new Map<string, EventHandler>();
  let registeredService: ServiceDef | null = null;

  const api: Partial<OpenClawPluginApi> = {
    pluginConfig: {
      licenseKey: "test-license-key",
      supabaseUrl: "https://test.supabase.co",
      supabaseAnonKey: "test-anon-key",
      backupIntervalMinutes: 30,
      ...pluginConfig,
    },
    config: {
      agents: { defaults: { workspace: "/tmp/kayzo-sync-test/workspace" } },
    } as unknown as OpenClawPluginApi["config"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as OpenClawPluginApi["logger"],
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    }) as unknown as OpenClawPluginApi["on"],
    registerService: vi.fn((svc: ServiceDef) => {
      registeredService = svc;
    }) as unknown as OpenClawPluginApi["registerService"],
  };

  return { api, handlers, getService: () => registeredService };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("kayzo-sync plugin", () => {
  let plugin: PluginDef;

  beforeEach(async () => {
    vi.clearAllMocks();
    plugin = (await import("./index.js")) as unknown as PluginDef;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has the correct id and name", () => {
    expect(plugin.id).toBe("kayzo-sync");
    expect(plugin.name).toBe("Kayzo Sync");
  });

  it("logs an error and returns early when licenseKey is missing", () => {
    const { api } = createMockApi({ licenseKey: undefined });
    plugin.register(api);
    expect(api.logger!.error).toHaveBeenCalledWith(
      expect.stringContaining("licenseKey and supabaseUrl are required"),
    );
    expect(api.on).not.toHaveBeenCalled();
  });

  describe("gateway_start — memory restore", () => {
    it("skips restore when memory files already exist locally", async () => {
      const fs = await import("node:fs/promises");
      // readdir returns files → memory is not empty
      vi.mocked(fs.readdir).mockResolvedValueOnce([
        { name: "MEMORY.md", isFile: () => true } as never,
      ]);
      vi.mocked(fs.readFile).mockResolvedValue("# Memory content");

      vi.stubGlobal("fetch", vi.fn());

      const { api, handlers } = createMockApi();
      plugin.register(api);
      await handlers.get("gateway_start")!({});

      // restore-memory should NOT be called because local memory exists
      expect(fetch).not.toHaveBeenCalled();
    });

    it("calls restore-memory when no local memory files exist", async () => {
      const fs = await import("node:fs/promises");
      // No local memory: readFile rejects (file not found), readdir returns empty
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const backupData = {
        memory_data: {
          files: { "MEMORY.md": "# Restored memory" },
          backedUpAt: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(backupData),
        }),
      );

      const { api, handlers } = createMockApi();
      plugin.register(api);
      await handlers.get("gateway_start")!({});

      expect(fetch).toHaveBeenCalledOnce();
      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain("restore-memory");
    });

    it("writes restored files to disk", async () => {
      const fs = await import("node:fs/promises");
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const backupData = {
        memory_data: {
          files: {
            "MEMORY.md": "# Restored memory",
            "memory/jobs.md": "# Jobs",
          },
          backedUpAt: new Date().toISOString(),
        },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(backupData),
        }),
      );

      const { api, handlers } = createMockApi();
      plugin.register(api);
      await handlers.get("gateway_start")!({});

      expect(fs.writeFile).toHaveBeenCalledTimes(2);
      const writtenPaths = vi.mocked(fs.writeFile).mock.calls.map((c) => c[0] as string);
      expect(writtenPaths.some((p) => p.endsWith("MEMORY.md"))).toBe(true);
      expect(writtenPaths.some((p) => p.endsWith("jobs.md"))).toBe(true);
    });

    it("skips restore when backup is empty", async () => {
      const fs = await import("node:fs/promises");
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(fs.readdir).mockResolvedValue([]);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ memory_data: null }),
        }),
      );

      const { api, handlers } = createMockApi();
      plugin.register(api);
      await handlers.get("gateway_start")!({});

      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it("continues without throwing when restore-memory fetch fails", async () => {
      const fs = await import("node:fs/promises");
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(fs.readdir).mockResolvedValue([]);

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

      const { api, handlers } = createMockApi();
      plugin.register(api);

      // Should resolve (not throw) even when the network call fails
      await expect(handlers.get("gateway_start")!({})).resolves.toBeUndefined();
      expect(api.logger!.warn).toHaveBeenCalledWith(
        expect.stringContaining("memory restore failed"),
      );
    });
  });

  describe("registerService — periodic backup", () => {
    it("registers a backup service", () => {
      const { api, getService } = createMockApi();
      plugin.register(api);
      expect(api.registerService).toHaveBeenCalledOnce();
      expect(getService()?.id).toBe("kayzo-sync-backup");
    });

    it("does not call backup-memory when there are no memory files", async () => {
      const fs = await import("node:fs/promises");
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));
      vi.mocked(fs.readdir).mockResolvedValue([]);

      vi.stubGlobal("fetch", vi.fn());
      vi.useFakeTimers();

      const { api, getService } = createMockApi({ backupIntervalMinutes: 1 });
      plugin.register(api);
      getService()!.start();

      vi.advanceTimersByTime(60_000);
      // Let any microtasks settle
      await vi.waitFor(() => {
        expect(fetch).not.toHaveBeenCalled();
      });

      getService()!.stop();
      vi.useRealTimers();
    });

    it("calls backup-memory when memory files exist", async () => {
      const fs = await import("node:fs/promises");
      vi.mocked(fs.readFile).mockResolvedValue("# Memory content");
      vi.mocked(fs.readdir).mockResolvedValue([{ name: "MEMORY.md", isFile: () => true } as never]);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        }),
      );
      vi.useFakeTimers();

      const { api, getService } = createMockApi({ backupIntervalMinutes: 1 });
      plugin.register(api);
      getService()!.start();

      vi.advanceTimersByTime(60_000);
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledOnce();
      });

      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain("backup-memory");

      getService()!.stop();
      vi.useRealTimers();
    });
  });
});
