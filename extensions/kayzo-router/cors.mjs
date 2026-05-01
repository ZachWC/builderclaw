// ── CORS helpers ──────────────────────────────────────────────────────────────

// Only allow Kayzo-owned Vercel preview deployments, not arbitrary *.vercel.app origins.
export const KAYZO_PREVIEW_ORIGIN = /^https:\/\/kayzo-[a-z0-9-]+\.vercel\.app$/;

/**
 * Returns an isAllowedOrigin predicate bound to the given appPublicUrl.
 * Caller (index.mjs) passes process.env.APP_PUBLIC_URL so env reading stays
 * in one place and this module remains side-effect-free.
 *
 * @param {string} appPublicUrl
 * @returns {(origin: string | undefined) => boolean}
 */
export function makeIsAllowedOrigin(appPublicUrl) {
  const allowed = new Set([appPublicUrl, "http://localhost:3000", "http://127.0.0.1:3000"]);
  return function isAllowedOrigin(origin) {
    if (!origin) {
      return false;
    }
    if (allowed.has(origin)) {
      return true;
    }
    return KAYZO_PREVIEW_ORIGIN.test(origin);
  };
}
