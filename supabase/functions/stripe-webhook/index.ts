import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Map Stripe price IDs to subscription tiers.
// Fill these in after creating products in the Stripe dashboard (Prompt 9).
// STRIPE_CLOUD_PRICE_ID → "cloud"  ($150/month)
// STRIPE_LOCAL_PRICE_ID → "local"  ($100/month)
const PRICE_TIER_MAP: Record<string, string> = {
  [Deno.env.get("STRIPE_CLOUD_PRICE_ID") ?? ""]: "cloud",
  [Deno.env.get("STRIPE_LOCAL_PRICE_ID") ?? ""]: "local",
};

function tierFromSubscription(subscription: Stripe.Subscription): string {
  for (const item of subscription.items.data) {
    const tier = PRICE_TIER_MAP[item.price.id];
    if (tier) return tier;
  }
  // Default tier when price ID is not in the map
  return "cloud";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const signature = req.headers.get("stripe-signature");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!signature || !webhookSecret) {
    return new Response(JSON.stringify({ error: "missing stripe signature or webhook secret" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = await req.text();
  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
    apiVersion: "2024-06-20",
    httpClient: Stripe.createFetchHttpClient(),
  });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (err) {
    console.error("Stripe signature verification failed:", err);
    return new Response(JSON.stringify({ error: "invalid stripe signature" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const stripeCustomerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id;

        const newStatus = subscription.status; // active | trialing | past_due | canceled | ...
        const newTier = tierFromSubscription(subscription);

        const { error } = await supabase
          .from("customers")
          .update({
            subscription_status: newStatus,
            subscription_tier: newTier,
          })
          .eq("stripe_customer_id", stripeCustomerId);

        if (error) {
          console.error("subscription update error:", error);
          return new Response(JSON.stringify({ error: "db update failed" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const stripeCustomerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id;

        const { error } = await supabase
          .from("customers")
          .update({ subscription_status: "canceled" })
          .eq("stripe_customer_id", stripeCustomerId);

        if (error) {
          console.error("subscription delete error:", error);
          return new Response(JSON.stringify({ error: "db update failed" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const stripeCustomerId =
          typeof invoice.customer === "string"
            ? invoice.customer
            : invoice.customer?.id ?? null;

        if (!stripeCustomerId) {
          console.warn("invoice.payment_failed: no customer id on invoice");
          break;
        }

        const { error } = await supabase
          .from("customers")
          .update({ subscription_status: "past_due" })
          .eq("stripe_customer_id", stripeCustomerId);

        if (error) {
          console.error("payment_failed update error:", error);
          return new Response(JSON.stringify({ error: "db update failed" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        break;
      }

      default:
        // Acknowledge unhandled event types without error
        console.log("unhandled stripe event type:", event.type);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("stripe-webhook error:", err);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
