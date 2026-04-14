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
    const { license_key, input_tokens, output_tokens } = await req.json();

    if (!license_key) {
      return new Response(JSON.stringify({ error: "license_key required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const inputTok = typeof input_tokens === "number" ? input_tokens : 0;
    const outputTok = typeof output_tokens === "number" ? output_tokens : 0;

    if (inputTok < 0 || outputTok < 0) {
      return new Response(JSON.stringify({ error: "token counts must be non-negative" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

    const { error } = await supabase.rpc("increment_usage", {
      p_license_key: license_key,
      p_month: month,
      p_input_tokens: inputTok,
      p_output_tokens: outputTok,
    });

    if (error) {
      console.error("increment_usage error:", error);
      return new Response(JSON.stringify({ error: "failed to log usage" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, month }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("log-usage error:", err);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
