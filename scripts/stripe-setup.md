# Kayzo -- Stripe Setup Checklist

Complete these steps in the Stripe dashboard before going live.
After each step, copy the ID/secret into `/home/kayzo/app/.env` on the VPS.

---

## 1. Create Products and Prices

### Kayzo Cloud — $150/month

1. Dashboard → **Product catalog** → **Add product**
2. Name: `Kayzo Cloud`
3. Pricing: Recurring · $150.00 · Monthly
4. Click **Save product**
5. Copy the **Price ID** (starts with `price_`) → set `STRIPE_CLOUD_PRICE_ID=price_xxx` in `.env`

### Kayzo Local — $100/month

1. Dashboard → **Product catalog** → **Add product**
2. Name: `Kayzo Local`
3. Pricing: Recurring · $100.00 · Monthly
4. Click **Save product**
5. Copy the **Price ID** → set `STRIPE_LOCAL_PRICE_ID=price_xxx` in `.env`

---

## 2. Create Payment Links

### Cloud link

1. Dashboard → **Payment Links** → **New**
2. Add product: **Kayzo Cloud**
3. Click **Create link**
4. Copy the URL — this is what you share with cloud customers

### Local link

1. Dashboard → **Payment Links** → **New**
2. Add product: **Kayzo Local**
3. Click **Create link**
4. Copy the URL — this is what you share with local customers

---

## 3. Create Webhook Endpoint

1. Dashboard → **Developers** → **Webhooks** → **Add endpoint**
2. Endpoint URL:
   ```
   https://YOUR_SUPABASE_URL/functions/v1/stripe-webhook
   ```
   (replace `YOUR_SUPABASE_URL` with your actual Supabase project URL)
3. Select events to listen for:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Click **Add endpoint**
5. Click **Reveal** under **Signing secret** → copy `whsec_xxx`

---

## 4. Set Secrets

Run these from `/Users/zachchristensen/Kayzo/builderclaw`:

```bash
supabase secrets set \
  STRIPE_SECRET_KEY="sk_live_..." \
  STRIPE_WEBHOOK_SECRET="whsec_..." \
  STRIPE_CLOUD_PRICE_ID="price_..." \
  STRIPE_LOCAL_PRICE_ID="price_..."
```

Then redeploy the webhook function:

```bash
supabase functions deploy stripe-webhook
```

---

## 5. Update VPS .env

Add to `/home/kayzo/app/.env` on the VPS:

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CLOUD_PRICE_ID=price_...
STRIPE_LOCAL_PRICE_ID=price_...
```

---

## 6. Verify

After a customer subscribes via the payment link:

- Check Supabase `customers` table — `subscription_status` should be `active`
- `subscription_tier` should be `cloud` or `local` (matched from price ID)
- Check Stripe dashboard → **Webhooks** → your endpoint → recent deliveries for 200 responses
