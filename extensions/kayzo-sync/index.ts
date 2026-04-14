import fs from "node:fs/promises";
import { resolve } from "node:path";
import { definePluginEntry } from "./api.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type PluginConfig = {
  licenseKey: string;
  supabaseUrl: string;
  supabaseAnonKey?: string;
  backupIntervalMinutes?: number;
};

type MemoryData = {
  files: Record<string, string>; // relPath → file content
  backedUpAt: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function edgeFunctionUrl(supabaseUrl: string, fn: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/functions/v1/${fn}`;
}

async function callEdgeFunction(
  supabaseUrl: string,
  anonKey: string,
  fn: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(edgeFunctionUrl(supabaseUrl, fn), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Edge function ${fn} returned ${res.status}`);
  }
  return res.json();
}

/**
 * Collect all memory markdown files from the workspace directory.
 * Looks for MEMORY.md, memory.md, and memory/*.md.
 * Returns a map of { relPath → content }.
 */
async function collectMemoryFiles(workspaceDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  // Candidates for top-level memory files
  for (const filename of ["MEMORY.md", "memory.md"]) {
    const absPath = resolve(workspaceDir, filename);
    try {
      const content = await fs.readFile(absPath, "utf-8");
      if (content.trim()) {
        files[filename] = content;
      }
    } catch {
      // File doesn't exist — skip
    }
  }

  // memory/ subdirectory
  const memoryDir = resolve(workspaceDir, "memory");
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const absPath = resolve(memoryDir, entry.name);
      try {
        const content = await fs.readFile(absPath, "utf-8");
        if (content.trim()) {
          files[`memory/${entry.name}`] = content;
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // memory/ dir doesn't exist — that's fine
  }

  return files;
}

/**
 * Returns true if the workspace has no memory files yet.
 */
async function isMemoryEmpty(workspaceDir: string): Promise<boolean> {
  const files = await collectMemoryFiles(workspaceDir);
  return Object.keys(files).length === 0;
}

/**
 * Write memory files back to the workspace from a backup.
 */
async function hydrateMemory(workspaceDir: string, memoryData: MemoryData): Promise<number> {
  const entries = Object.entries(memoryData.files);
  let written = 0;
  for (const [relPath, content] of entries) {
    if (!content.trim()) {
      continue;
    }
    const absPath = resolve(workspaceDir, relPath);
    // Ensure parent directory exists (e.g. memory/)
    await fs.mkdir(resolve(absPath, ".."), { recursive: true });
    await fs.writeFile(absPath, content, "utf-8");
    written++;
  }
  return written;
}

// ── Plugin entry ──────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "kayzo-sync",
  name: "Kayzo Sync",
  description: "Backs up agent memory to Supabase and restores it on startup.",

  register(api) {
    const cfg = api.pluginConfig as PluginConfig | undefined;

    if (!cfg?.licenseKey || !cfg?.supabaseUrl) {
      api.logger.error(
        "kayzo-sync: licenseKey and supabaseUrl are required in plugin config -- plugin disabled",
      );
      return;
    }

    const { licenseKey, supabaseUrl } = cfg;
    const anonKey = cfg.supabaseAnonKey ?? "";
    const backupIntervalMs = (cfg.backupIntervalMinutes ?? 30) * 60_000;

    const workspaceDir: string =
      (
        api.config as Record<string, unknown> & {
          agents?: { defaults?: { workspace?: string } };
        }
      ).agents?.defaults?.workspace ??
      resolve(process.env.HOME ?? "~", ".kayzo/agents/main/workspace");

    // ── gateway_start: restore memory if local store is empty ─────────────────

    api.on("gateway_start", async (_event) => {
      try {
        const empty = await isMemoryEmpty(workspaceDir);
        if (!empty) {
          // Local memory exists — no restoration needed
          return;
        }

        const result = (await callEdgeFunction(supabaseUrl, anonKey, "restore-memory", {
          license_key: licenseKey,
        })) as { memory_data: MemoryData | null; updated_at?: string };

        if (!result.memory_data || Object.keys(result.memory_data.files ?? {}).length === 0) {
          // No backup found — first run
          return;
        }

        await fs.mkdir(workspaceDir, { recursive: true });
        const count = await hydrateMemory(workspaceDir, result.memory_data);

        api.logger.info(
          `Memory restored from Supabase backup (${count} file(s), backed up ${result.memory_data.backedUpAt ?? result.updated_at ?? "unknown"})`,
        );
      } catch (err) {
        // Non-fatal — gateway continues without restoration
        api.logger.warn(
          `kayzo-sync: memory restore failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    // ── Service: periodic backup every N minutes ──────────────────────────────

    let backupInterval: ReturnType<typeof setInterval> | null = null;

    async function runBackup(): Promise<void> {
      const files = await collectMemoryFiles(workspaceDir);
      if (Object.keys(files).length === 0) {
        // Nothing to back up yet
        return;
      }

      const memoryData: MemoryData = {
        files,
        backedUpAt: new Date().toISOString(),
      };

      await callEdgeFunction(supabaseUrl, anonKey, "backup-memory", {
        license_key: licenseKey,
        memory_data: memoryData,
      });

      api.logger.info(`kayzo-sync: memory backed up (${Object.keys(files).length} file(s))`);
    }

    api.registerService({
      id: "kayzo-sync-backup",

      start: () => {
        backupInterval = setInterval(() => {
          // Fire-and-forget — never interrupt the agent
          runBackup().catch((err) => {
            api.logger.warn(
              `kayzo-sync: backup failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }, backupIntervalMs);
      },

      stop: () => {
        if (backupInterval) {
          clearInterval(backupInterval);
          backupInterval = null;
        }
      },
    });
  },
});
