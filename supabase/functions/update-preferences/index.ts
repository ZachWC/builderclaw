import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_MODES = ["always_ask", "threshold", "always_act"] as const;
type Mode = (typeof VALID_MODES)[number];

function isValidMode(v: unknown): v is Mode {
  return typeof v === "string" && (VALID_MODES as readonly string[]).includes(v);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { license_key } = body;

    if (!license_key) {
      return new Response(JSON.stringify({ error: "license_key required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate optional fields when present
    if (body.ordering_mode !== undefined && !isValidMode(body.ordering_mode)) {
      return new Response(
        JSON.stringify({ error: "ordering_mode must be always_ask | threshold | always_act" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (body.scheduling_mode !== undefined && !isValidMode(body.scheduling_mode)) {
      return new Response(
        JSON.stringify({ error: "scheduling_mode must be always_ask | threshold | always_act" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (body.email_replies_mode !== undefined && !isValidMode(body.email_replies_mode)) {
      return new Response(
        JSON.stringify({
          error: "email_replies_mode must be always_ask | threshold | always_act",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (body.flagging_mode !== undefined && !isValidMode(body.flagging_mode)) {
      return new Response(
        JSON.stringify({ error: "flagging_mode must be always_ask | threshold | always_act" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (
      body.ordering_threshold !== undefined &&
      (typeof body.ordering_threshold !== "number" || body.ordering_threshold < 0)
    ) {
      return new Response(
        JSON.stringify({ error: "ordering_threshold must be a non-negative number" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (
      body.bid_markup !== undefined &&
      (typeof body.bid_markup !== "number" || body.bid_markup < 0 || body.bid_markup > 200)
    ) {
      return new Response(JSON.stringify({ error: "bid_markup must be between 0 and 200" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Build update payload from whichever fields were provided
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.ordering_mode !== undefined) update.ordering_mode = body.ordering_mode;
    if (body.ordering_threshold !== undefined) update.ordering_threshold = body.ordering_threshold;
    if (body.scheduling_mode !== undefined) update.scheduling_mode = body.scheduling_mode;
    if (body.scheduling_threshold !== undefined)
      update.scheduling_threshold = body.scheduling_threshold;
    if (body.email_replies_mode !== undefined) update.email_replies_mode = body.email_replies_mode;
    if (body.flagging_mode !== undefined) update.flagging_mode = body.flagging_mode;
    if (body.bid_markup !== undefined) update.bid_markup = body.bid_markup;

    const { error } = await supabase
      .from("contractor_preferences")
      .upsert({ license_key, ...update }, { onConflict: "license_key" });

    if (error) {
      console.error("upsert error:", error);
      return new Response(JSON.stringify({ error: "failed to update preferences" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Write refresh flag file so the running gateway picks up the change within 60 s
    try {
      await Deno.writeTextFile(
        `/tmp/kayzo-prefs-refresh-${license_key}`,
        new Date().toISOString(),
      );
    } catch {
      // Non-fatal: flag write only works when function runs on the same host as the gateway.
      // In hosted Supabase deployments this is a no-op; the license plugin polls Supabase directly.
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("update-preferences error:", err);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
