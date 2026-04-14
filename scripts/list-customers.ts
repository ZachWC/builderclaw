#!/usr/bin/env npx tsx
// Kayzo -- List Customers
//
// Usage:
//   npx tsx scripts/list-customers.ts
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env or environment.

import * as fs from "fs";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";

// Load .env from app dir if not already set
const envFile = path.resolve(process.env.APP_DIR ?? "/home/kayzo/app", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Current month key: YYYY-MM
const monthKey = new Date().toISOString().slice(0, 7);

interface Customer {
  id: string;
  name: string;
  email: string;
  slug: string;
  gateway_type: string;
  gateway_url: string | null;
  subscription_status: string;
  subscription_tier: string | null;
  free_account: boolean;
  provisioned_port: number | null;
  created_at: string;
}

interface UsageLog {
  license_key: string;
  month: string;
  input_tokens: number;
  output_tokens: number;
}

async function main() {
  const { data: customers, error: custErr } = await supabase
    .from("customers")
    .select("*")
    .order("created_at", { ascending: true });

  if (custErr) {
    console.error("Failed to fetch customers:", custErr.message);
    process.exit(1);
  }

  const { data: usageLogs, error: usageErr } = await supabase
    .from("usage_logs")
    .select("license_key, month, input_tokens, output_tokens")
    .eq("month", monthKey);

  if (usageErr) {
    console.error("Failed to fetch usage logs:", usageErr.message);
    process.exit(1);
  }

  // Build usage map keyed by license_key
  const usageMap = new Map<string, { input: number; output: number }>();
  for (const row of (usageLogs as UsageLog[]) ?? []) {
    usageMap.set(row.license_key, {
      input: row.input_tokens,
      output: row.output_tokens,
    });
  }

  // Fetch license keys to correlate usage
  const { data: prefs } = await supabase.from("customers").select("id, license_key");

  const licenseMap = new Map<string, string>();
  for (const row of (prefs as { id: string; license_key: string }[]) ?? []) {
    licenseMap.set(row.id, row.license_key);
  }

  if (!customers || customers.length === 0) {
    console.log("No customers found.");
    return;
  }

  // Column widths
  const COL = {
    name: 22,
    slug: 18,
    type: 22,
    status: 12,
    tokens: 14,
    created: 12,
  };

  const hr = "─".repeat(
    COL.name + COL.slug + COL.type + COL.status + COL.tokens + COL.created + 13,
  );

  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);

  console.log("\n" + hr);
  console.log(
    "│ " +
      pad("Name", COL.name) +
      "│ " +
      pad("Slug", COL.slug) +
      "│ " +
      pad("Type", COL.type) +
      "│ " +
      pad("Status", COL.status) +
      "│ " +
      pad("Tokens (mo)", COL.tokens) +
      "│ " +
      pad("Created", COL.created) +
      "│",
  );
  console.log(hr);

  for (const c of customers as Customer[]) {
    const licenseKey = licenseMap.get(c.id) ?? "";
    const usage = usageMap.get(licenseKey);
    const totalTokens = usage ? usage.input + usage.output : 0;
    const tokensStr = totalTokens > 0 ? totalTokens.toLocaleString() : "—";

    // Type label
    let typeLabel: string;
    if (c.gateway_type === "cloud") {
      typeLabel = "[CLOUD]";
      if (c.free_account) {
        typeLabel += " [FREE]";
      }
    } else {
      typeLabel = "[LOCAL]";
      if (!c.gateway_url) {
        typeLabel += " [URL PENDING]";
      }
      if (c.free_account) {
        typeLabel += " [FREE]";
      }
    }

    const createdDate = c.created_at.slice(0, 10);

    console.log(
      "│ " +
        pad(c.name, COL.name) +
        "│ " +
        pad(c.slug, COL.slug) +
        "│ " +
        pad(typeLabel, COL.type) +
        "│ " +
        pad(c.subscription_status, COL.status) +
        "│ " +
        pad(tokensStr, COL.tokens) +
        "│ " +
        pad(createdDate, COL.created) +
        "│",
    );
  }

  console.log(hr);
  console.log(`  Total: ${(customers as Customer[]).length} customer(s)   Month: ${monthKey}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
