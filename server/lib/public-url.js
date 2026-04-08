/**
 * Offentlig base-URL til Stripe Checkout (success/cancel), OAuth callbacks, eBay challenge, m.m.
 *
 * Sæt VELDEN_LOCAL=1 (fx via `npm run dev`) for at tvinge http://localhost:PORT og ignorere
 * PUBLIC_URL / URL / DEPLOY_PRIME_URL — praktisk når .env er kopieret fra Netlify.
 */

function resolvePublicUrl() {
  const port = Number(process.env.PORT) || 3000;
  const local = `http://localhost:${port}`.replace(/\/$/, "");
  if (/^1|true|yes$/i.test(String(process.env.VELDEN_LOCAL || "").trim())) {
    return local;
  }
  const fromEnv =
    process.env.PUBLIC_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || local;
  return String(fromEnv || local)
    .trim()
    .replace(/\/$/, "");
}

module.exports = { resolvePublicUrl };
