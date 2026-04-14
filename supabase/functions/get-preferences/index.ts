import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { license_key } = await req.json();
    if (!license_key) {
      return new Response(JSON.stringify({ error: "license_key required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: prefs, error } = await supabase
      .from("contractor_preferences")
      .select("*")
      .eq("license_key", license_key)
      .single();

    if (error || !prefs) {
      return new Response(JSON.stringify({ error: "preferences not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        license_key: prefs.license_key,
        ordering: {
          mode: prefs.ordering_mode,
          threshold: prefs.ordering_threshold,
        },
        scheduling: {
          mode: prefs.scheduling_mode,
          threshold: prefs.scheduling_threshold,
        },
        emailReplies: {
          mode: prefs.email_replies_mode,
        },
        flagging: {
          mode: prefs.flagging_mode,
        },
        bidMarkup: prefs.bid_markup,
        updatedAt: prefs.updated_at,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("get-preferences error:", err);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
