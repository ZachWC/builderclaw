import fs from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "./api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ─────────────────────────────────────────────────────────────────────

type PluginConfig = {
  licenseKey: string;
  supabaseUrl: string;
  supabaseAnonKey?: string;
  customerSlug?: string;
};

type LicenseResult = {
  valid: boolean;
  tier: string;
  status: string;
  freeAccount: boolean;
  gatewayType: string;
  gatewayUrl: string | null;
  overBudget: boolean;
  tokensUsed: number;
  tokenBudget: number;
};

type Preferences = {
  ordering: { mode: string; threshold: number | null };
  scheduling: { mode: string; threshold: number | null };
  emailReplies: { mode: string };
  flagging: { mode: string };
  bidMarkup: number;
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
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Edge function ${fn} returned ${res.status}`);
  }
  return res.json();
}

/**
 * Read the PREFERENCES.md template and substitute all placeholders.
 */
async function buildPreferencesContext(prefs: Preferences): Promise<string> {
  const templatePath = resolve(__dirname, "../../skills/kayzo/PREFERENCES.md");
  let template: string;
  try {
    template = await fs.readFile(templatePath, "utf-8");
  } catch {
    // Template missing — return a minimal inline fallback
    return [
      "## Contractor Preferences",
      `- Ordering: ${prefs.ordering.mode}`,
      `- Scheduling: ${prefs.scheduling.mode}`,
      `- Email replies: always_ask`,
      `- Flagging: ${prefs.flagging.mode}`,
      `- Bid markup: ${prefs.bidMarkup}%`,
    ].join("\n");
  }

  const orderingThresholdText =
    prefs.ordering.mode === "threshold" && prefs.ordering.threshold != null
      ? `Auto-approve under $${prefs.ordering.threshold}`
      : "";

  return (
    template
      .replaceAll("{ORDERING_MODE}", prefs.ordering.mode)
      .replaceAll("{ORDERING_THRESHOLD_TEXT}", orderingThresholdText)
      .replaceAll("{SCHEDULING_MODE}", prefs.scheduling.mode)
      // Email replies always require contractor approval before sending — never autonomous.
      .replaceAll("{EMAIL_REPLIES_MODE}", "always_ask")
      .replaceAll("{FLAGGING_MODE}", prefs.flagging.mode)
      .replaceAll("{MARKUP_PERCENTAGE}", String(prefs.bidMarkup))
  );
}

// ── Plugin entry ──────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "kayzo-license",
  name: "Kayzo License",
  description: "License validation, usage tracking, and preferences injection for Kayzo gateways.",

  register(api) {
    const cfg = api.pluginConfig as PluginConfig | undefined;

    if (!cfg?.licenseKey || !cfg?.supabaseUrl) {
      api.logger.error(
        "kayzo-license: licenseKey and supabaseUrl are required in plugin config -- plugin disabled",
      );
      return;
    }

    const { licenseKey, supabaseUrl, customerSlug = licenseKey.slice(0, 8) } = cfg;
    // Supabase Edge Functions are public endpoints; the anon key may be omitted
    // for self-hosted deployments where the function has no auth.
    const anonKey = cfg.supabaseAnonKey ?? "";

    // Resolve paths relative to the agent workspace
    // agents.defaults.workspace is the configured workspace dir; one level up holds
    // the per-customer cache/context files.
    const workspaceDir: string =
      (
        api.config as Record<string, unknown> & {
          agents?: { defaults?: { workspace?: string } };
        }
      ).agents?.defaults?.workspace ?? resolve(__dirname, "../../.kayzo/agents/main/workspace");

    const agentDir = resolve(workspaceDir, "..");
    const licenseCachePath = resolve(agentDir, "license-cache.json");
    const preferencesContextPath = resolve(agentDir, "preferences-context.md");
    const budgetAlertsPath = resolve(agentDir, "budget-alerts.log");

    // In-memory state
    let cachedPreferencesContext = "";
    let cachedLicense: LicenseResult | null = null;
    // Per-run token accumulator: runId → { input, output }
    const runUsage = new Map<string, { input: number; output: number }>();
    // Tokens used in this gateway session not yet synced to Supabase
    let pendingTokens = 0;

    // ── Core refresh: validate license + fetch prefs, write derived files ────

    async function refreshLicenseAndPreferences(): Promise<{
      license: LicenseResult;
      prefs: Preferences;
    }> {
      const [licenseRaw, prefsRaw] = await Promise.all([
        callEdgeFunction(supabaseUrl, anonKey, "validate-license", { license_key: licenseKey }),
        callEdgeFunction(supabaseUrl, anonKey, "get-preferences", { license_key: licenseKey }),
      ]);

      const license = licenseRaw as LicenseResult;
      cachedLicense = license;
      const prefsResponse = prefsRaw as {
        ordering: { mode: string; threshold: number | null };
        scheduling: { mode: string; threshold: number | null };
        emailReplies: { mode: string };
        flagging: { mode: string };
        bidMarkup: number;
      };

      const prefs: Preferences = {
        ordering: prefsResponse.ordering ?? { mode: "always_ask", threshold: null },
        scheduling: prefsResponse.scheduling ?? { mode: "always_ask", threshold: null },
        emailReplies: prefsResponse.emailReplies ?? { mode: "always_ask" },
        flagging: prefsResponse.flagging ?? { mode: "always_act" },
        bidMarkup: prefsResponse.bidMarkup ?? 20,
      };

      // Write license cache
      await fs.writeFile(
        licenseCachePath,
        JSON.stringify({ ...license, cachedAt: new Date().toISOString() }, null, 2),
        "utf-8",
      );

      // Generate and cache preferences context
      const contextContent = await buildPreferencesContext(prefs);
      await fs.writeFile(preferencesContextPath, contextContent, "utf-8");
      cachedPreferencesContext = contextContent;

      return { license, prefs };
    }

    // ── gateway_start ─────────────────────────────────────────────────────────

    api.on("gateway_start", async (_event) => {
      try {
        const { license, prefs: _prefs } = await refreshLicenseAndPreferences();

        const statusLabel = license.valid ? "valid" : "invalid";
        api.logger.info(
          `Kayzo v${process.env.npm_package_version ?? "?"} -- ${customerSlug} -- license: ${statusLabel}`,
        );

        if (license.overBudget) {
          const alertLine = `[${new Date().toISOString()}] ${customerSlug}: monthly token budget exceeded (${license.tokensUsed}/${license.tokenBudget})\n`;
          api.logger.warn(`kayzo-license: monthly token budget exceeded for ${customerSlug}`);
          await fs.appendFile(budgetAlertsPath, alertLine, "utf-8").catch(() => undefined);
        }

        // Fire-and-forget: update customers.current_version via Supabase REST PATCH
        fetch(
          `${supabaseUrl.replace(/\/$/, "")}/rest/v1/customers?license_key=eq.${encodeURIComponent(licenseKey)}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              apikey: anonKey,
              Authorization: `Bearer ${anonKey}`,
              Prefer: "return=minimal",
            },
            body: JSON.stringify({
              current_version: process.env.npm_package_version ?? "unknown",
            }),
          },
        ).catch(() => undefined);
      } catch (err) {
        api.logger.error(
          `kayzo-license: startup check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Non-fatal: gateway continues even if license check fails (uses cached result if present)
        try {
          const cached = JSON.parse(await fs.readFile(licenseCachePath, "utf-8"));
          api.logger.warn(
            `kayzo-license: using cached license from ${cached.cachedAt} -- ${customerSlug}`,
          );
        } catch {
          // No cache either — log and continue
          api.logger.warn(
            "kayzo-license: no license cache available, continuing without validation",
          );
        }
      }
    });

    // ── before_agent_start: enforce budget, inject preferences ───────────────

    api.on("before_agent_start", async (_event) => {
      // Budget enforcement: block run if this customer is over their monthly limit.
      // Free accounts are never blocked. pendingTokens covers usage in this session
      // that hasn't been synced to Supabase yet.
      if (cachedLicense && !cachedLicense.freeAccount && cachedLicense.tokenBudget > 0) {
        const effectiveUsed = cachedLicense.tokensUsed + pendingTokens;

        if (effectiveUsed >= cachedLicense.tokenBudget) {
          throw new Error(
            `Monthly token budget exceeded (${effectiveUsed.toLocaleString()} / ${cachedLicense.tokenBudget.toLocaleString()} tokens used). ` +
              `Budget resets at the start of next month.`,
          );
        }

        // Warn at 80% so the agent can surface it to the contractor.
        const usagePct = effectiveUsed / cachedLicense.tokenBudget;
        if (usagePct >= 0.8) {
          const remaining = cachedLicense.tokenBudget - effectiveUsed;
          const alertLine = `[${new Date().toISOString()}] ${customerSlug}: at ${Math.round(usagePct * 100)}% of monthly budget (${effectiveUsed.toLocaleString()}/${cachedLicense.tokenBudget.toLocaleString()} tokens used, ~${remaining.toLocaleString()} remaining)\n`;
          await fs.appendFile(budgetAlertsPath, alertLine, "utf-8").catch(() => undefined);
          api.logger.warn(
            `kayzo-license: ${customerSlug} is at ${Math.round(usagePct * 100)}% of monthly token budget`,
          );

          const budgetWarning = `\n\n---\n⚠️ Monthly usage notice: this account has used ${Math.round(usagePct * 100)}% of its monthly token budget. Approximately ${remaining.toLocaleString()} tokens remain. Let the contractor know if relevant.`;
          const baseContext =
            cachedPreferencesContext ||
            (await fs.readFile(preferencesContextPath, "utf-8").catch(() => ""));
          return { appendSystemContext: baseContext + budgetWarning };
        }
      }

      // Re-read from disk in case preferences were refreshed by the watcher
      if (!cachedPreferencesContext) {
        try {
          cachedPreferencesContext = await fs.readFile(preferencesContextPath, "utf-8");
        } catch {
          // File not written yet (first run, startup still in progress)
          return;
        }
      }
      return { appendSystemContext: cachedPreferencesContext };
    });

    // ── llm_output: accumulate per-run token usage ────────────────────────────

    api.on("llm_output", (event) => {
      if (!event.usage) {
        return;
      }
      const existing = runUsage.get(event.runId) ?? { input: 0, output: 0 };
      runUsage.set(event.runId, {
        input: existing.input + (event.usage.input ?? 0),
        output: existing.output + (event.usage.output ?? 0),
      });
    });

    // ── agent_end: fire-and-forget usage log ──────────────────────────────────

    api.on("agent_end", (event) => {
      // Find any run accumulated in this session.
      // agent_end doesn't carry a runId, so flush all pending runs.
      if (runUsage.size === 0) {
        return;
      }

      let totalInput = 0;
      let totalOutput = 0;
      for (const usage of runUsage.values()) {
        totalInput += usage.input;
        totalOutput += usage.output;
      }
      runUsage.clear();

      if (totalInput === 0 && totalOutput === 0) {
        return;
      }

      // Advance in-memory counters immediately so the next run in this session
      // sees the updated usage without waiting for a Supabase round-trip.
      const runTotal = totalInput + totalOutput;
      pendingTokens += runTotal;
      if (cachedLicense) {
        cachedLicense.tokensUsed += runTotal;
        if (!cachedLicense.freeAccount && cachedLicense.tokenBudget > 0) {
          cachedLicense.overBudget = cachedLicense.tokensUsed >= cachedLicense.tokenBudget;
        }
      }

      // Fire-and-forget — never await
      callEdgeFunction(supabaseUrl, anonKey, "log-usage", {
        license_key: licenseKey,
        input_tokens: totalInput,
        output_tokens: totalOutput,
      }).catch((err) => {
        api.logger.warn(
          `kayzo-license: usage log failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      void event; // suppress unused warning
    });

    // ── Service: preferences watcher (60s) + re-validation (24h) ─────────────

    let refreshInterval: ReturnType<typeof setInterval> | null = null;
    let revalidateInterval: ReturnType<typeof setInterval> | null = null;

    api.registerService({
      id: "kayzo-license-watcher",

      start: () => {
        const flagPath = `/tmp/kayzo-prefs-refresh-${licenseKey}`;

        // Preferences refresh watcher — every 60 seconds
        refreshInterval = setInterval(async () => {
          try {
            await fs.access(flagPath);
            // Flag exists — refresh
            await refreshLicenseAndPreferences();
            await fs.unlink(flagPath).catch(() => undefined);
            // Clear in-memory context so next before_agent_start re-reads from disk
            cachedPreferencesContext = "";
            api.logger.info(`kayzo-license: preferences refreshed for ${customerSlug}`);
          } catch {
            // Flag doesn't exist — normal, do nothing
          }
        }, 60_000);

        // Periodic re-validation — every 24 hours
        revalidateInterval = setInterval(
          async () => {
            try {
              await refreshLicenseAndPreferences();
              cachedPreferencesContext = "";
              // Supabase now has the latest token count — reset the local accumulator
              pendingTokens = 0;
              api.logger.info(`kayzo-license: 24h re-validation complete for ${customerSlug}`);
            } catch (err) {
              api.logger.warn(
                `kayzo-license: 24h re-validation failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          },
          24 * 60 * 60_000,
        );
      },

      stop: () => {
        if (refreshInterval) {
          clearInterval(refreshInterval);
          refreshInterval = null;
        }
        if (revalidateInterval) {
          clearInterval(revalidateInterval);
          revalidateInterval = null;
        }
      },
    });
  },
});
