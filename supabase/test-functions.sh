#!/usr/bin/env bash
# Kayzo -- Edge Function smoke tests
# Usage: ./supabase/test-functions.sh
#
# Requires:
#   SUPABASE_URL        e.g. https://xxxx.supabase.co
#   SUPABASE_ANON_KEY   your project anon key
#   TEST_LICENSE_KEY    a valid license_key already in the customers table
#
# Optional:
#   STRIPE_TEST_PAYLOAD  path to a Stripe webhook JSON fixture

set -euo pipefail

BASE_URL="${SUPABASE_URL:?set SUPABASE_URL}/functions/v1"
ANON="${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY}"
LICENSE="${TEST_LICENSE_KEY:?set TEST_LICENSE_KEY}"

ok()  { echo "  [PASS] $*"; }
fail(){ echo "  [FAIL] $*"; exit 1; }

call() {
  local fn="$1"; shift
  curl -s -X POST \
    -H "Authorization: Bearer ${ANON}" \
    -H "Content-Type: application/json" \
    -d "$@" \
    "${BASE_URL}/${fn}"
}

echo ""
echo "=== 1. validate-license (valid key) ==="
RESP=$(call validate-license "{\"license_key\":\"${LICENSE}\"}")
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
echo "$RESP" | grep -q '"valid"' && ok "response contains 'valid' field" || fail "missing 'valid' field"

echo ""
echo "=== 2. validate-license (bad key) ==="
RESP=$(call validate-license '{"license_key":"does-not-exist-xxx"}')
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
echo "$RESP" | grep -q '"valid":false' && ok "invalid key returns valid:false" || fail "expected valid:false"

echo ""
echo "=== 3. get-preferences ==="
RESP=$(call get-preferences "{\"license_key\":\"${LICENSE}\"}")
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
echo "$RESP" | grep -q '"ordering"' && ok "response contains 'ordering' field" || fail "missing 'ordering' field"

echo ""
echo "=== 4. update-preferences ==="
RESP=$(call update-preferences "{
  \"license_key\": \"${LICENSE}\",
  \"ordering_mode\": \"threshold\",
  \"ordering_threshold\": 750,
  \"bid_markup\": 25
}")
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
echo "$RESP" | grep -q '"ok":true' && ok "update returned ok:true" || fail "expected ok:true"

echo ""
echo "=== 4b. verify updated preferences ==="
RESP=$(call get-preferences "{\"license_key\":\"${LICENSE}\"}")
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
echo "$RESP" | grep -q '"threshold"' && ok "ordering.mode updated to threshold" || fail "ordering mode not updated"

echo ""
echo "=== 5. log-usage ==="
RESP=$(call log-usage "{
  \"license_key\": \"${LICENSE}\",
  \"input_tokens\": 1000,
  \"output_tokens\": 500
}")
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
echo "$RESP" | grep -q '"ok":true' && ok "log-usage returned ok:true" || fail "expected ok:true"
echo "$RESP" | grep -q '"month"' && ok "response contains month field" || fail "missing 'month' field"

echo ""
echo "=== 6. log-usage (verify budget tracking) ==="
RESP=$(call validate-license "{\"license_key\":\"${LICENSE}\"}")
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
echo "$RESP" | grep -q '"tokensUsed"' && ok "tokensUsed present after log" || fail "missing tokensUsed"

echo ""
echo "=== 7. stripe-webhook (skipped -- requires real signature) ==="
echo "  [SKIP] To test manually:"
echo "         stripe listen --forward-to ${BASE_URL}/stripe-webhook"
echo "         stripe trigger customer.subscription.updated"

echo ""
echo "=== All tests complete ==="
