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

    // Fetch customer
    const { data: customer, error: customerErr } = await supabase
      .from("customers")
      .select(
        "license_key, subscription_status, subscription_tier, free_account, monthly_token_budget, gateway_type, gateway_url",
      )
      .eq("license_key", license_key)
      .single();

    if (customerErr || !customer) {
      // Log failed check
      await supabase.from("license_checks").insert({
        license_key,
        result: "invalid",
      });
      return new Response(JSON.stringify({ valid: false }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const validStatuses = ["active", "trialing"];
    const valid =
      customer.free_account === true || validStatuses.includes(customer.subscription_status);

    // Fetch token usage for current month
    const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
    const { data: usage } = await supabase
      .from("usage_logs")
      .select("input_tokens, output_tokens")
      .eq("license_key", license_key)
      .eq("month", month)
      .single();

    const tokensUsed = usage ? usage.input_tokens + usage.output_tokens : 0;
    const tokenBudget = customer.monthly_token_budget;
    const overBudget = !customer.free_account && tokensUsed >= tokenBudget;

    // Log successful check
    await supabase.from("license_checks").insert({
      license_key,
      result: valid && !overBudget ? "valid" : "invalid",
    });

    return new Response(
      JSON.stringify({
        valid: valid && !overBudget,
        tier: customer.subscription_tier,
        status: customer.subscription_status,
        freeAccount: customer.free_account,
        gatewayType: customer.gateway_type,
        gatewayUrl: customer.gateway_url,
        overBudget,
        tokensUsed,
        tokenBudget,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("validate-license error:", err);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
