#!/usr/bin/env npx tsx
// Kayzo -- Set Gateway URL
//
// Updates customers.gateway_url in Supabase for a local customer once they
// share the URL of their self-hosted Kayzo gateway.
//
// Usage:
//   npx tsx scripts/set-gateway-url.ts --slug bob-local --url https://kayzo.bob.example.com

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

// Also try repo-local .env
const repoEnv = path.resolve(__dirname, "../.env");
if (fs.existsSync(repoEnv)) {
  for (const line of fs.readFileSync(repoEnv, "utf8").split("\n")) {
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

// ── Arg parsing ───────────────────────────────────────────────────────────────

let slug = "";
let url = "";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--slug" && args[i + 1]) {
    slug = args[++i];
  } else if (args[i] === "--url" && args[i + 1]) {
    url = args[++i];
  } else {
    console.error(`Unknown argument: ${args[i]}`);
    process.exit(1);
  }
}

if (!slug) {
  console.error("Error: --slug is required");
  process.exit(1);
}
if (!url) {
  console.error("Error: --url is required");
  process.exit(1);
}

// Basic URL validation
try {
  new URL(url);
} catch {
  console.error(`Error: --url "${url}" is not a valid URL`);
  process.exit(1);
}

// ── Update ────────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  // Verify slug exists
  const { data: existing, error: fetchErr } = await supabase
    .from("customers")
    .select("id, name, slug, gateway_type, gateway_url")
    .eq("slug", slug)
    .single();

  if (fetchErr || !existing) {
    console.error(`Error: customer with slug "${slug}" not found`);
    process.exit(1);
  }

  if (existing.gateway_type !== "local") {
    console.error(
      `Error: customer "${slug}" is a cloud customer (gateway_type=${existing.gateway_type}). ` +
        `Only local customers have a configurable gateway_url.`,
    );
    process.exit(1);
  }

  const { error: updateErr } = await supabase
    .from("customers")
    .update({ gateway_url: url })
    .eq("slug", slug);

  if (updateErr) {
    console.error("Failed to update gateway_url:", updateErr.message);
    process.exit(1);
  }

  console.log(`\n  [ok] Gateway URL set for "${existing.name}" (${slug})`);
  console.log(`       ${url}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
