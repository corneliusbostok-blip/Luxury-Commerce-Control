/**
 * eBay OAuth (client credentials / bruger-token) + Browse API — delt mellem sourcing-health og discovery.
 */

/**
 * @param {string} [clientId]
 */
function ebaySandboxMode(clientId) {
  const ex = String(process.env.EBAY_USE_SANDBOX || "").toLowerCase().trim();
  if (ex === "false" || ex === "0" || ex === "no" || ex === "off") return false;
  if (ex === "true" || ex === "1" || ex === "yes" || ex === "on") return true;
  const b = String(process.env.EBAY_ENV || "").toLowerCase();
  if (b === "sandbox") return true;
  if (/-SBX-/i.test(String(clientId || "").trim())) return true;
  return false;
}

function ebayOAuthScopeString() {
  const raw = String(process.env.EBAY_OAUTH_SCOPE || "").trim();
  if (!raw) return "https://api.ebay.com/oauth/api_scope";
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}

function ebayMarketplaceId() {
  return String(process.env.EBAY_MARKETPLACE_ID || "EBAY_US").trim() || "EBAY_US";
}

function ebayAcceptLanguage() {
  return String(process.env.EBAY_ACCEPT_LANGUAGE || "en-US,en;q=0.9").trim() || "en-US,en;q=0.9";
}

/**
 * @returns {Promise<{ ok: boolean, status: number, accessToken?: string, error?: string }>}
 */
async function ebayFetchApplicationAccessToken(clientId, clientSecret, sandbox) {
  const url = sandbox
    ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
    : "https://api.ebay.com/identity/v1/oauth2/token";
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: ebayOAuthScopeString(),
      }).toString(),
    });
    const text = await r.text();
    let j = {};
    try {
      j = JSON.parse(text);
    } catch {
      /* ignore */
    }
    const err = j.error_description || j.error || (text && text.slice(0, 240));
    if (!r.ok) return { ok: false, status: r.status, error: String(err || r.status) };
    if (!j.access_token) return { ok: false, status: r.status, error: "Intet access_token i eBay-svar." };
    return { ok: true, status: r.status, accessToken: j.access_token };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object | null} integrations — store_config.integrations (fuld, serverside)
 * @returns {Promise<{ ok: boolean, accessToken?: string, sandbox?: boolean, error?: string, status?: number }>}
 */
async function getEbayAccessTokenFromIntegrations(integrations) {
  const e = integrations && integrations.ebay;
  if (!e || typeof e !== "object") return { ok: false, error: "ebay integration mangler" };
  const clientId = String(e.clientId || "").trim();
  const clientSecret = String(e.clientSecret || "").trim();
  const userToken = String(e.oauthToken || "").trim();
  const sandbox = ebaySandboxMode(clientId);
  if (!clientId) return { ok: false, error: "client_id mangler" };
  if (clientSecret) {
    const tok = await ebayFetchApplicationAccessToken(clientId, clientSecret, sandbox);
    if (!tok.ok) return { ok: false, error: tok.error, status: tok.status, sandbox };
    return { ok: true, accessToken: tok.accessToken, sandbox };
  }
  if (userToken) return { ok: true, accessToken: userToken, sandbox };
  return { ok: false, error: "client_secret eller oauth_token mangler" };
}

/**
 * Let Browse API-kald — item_summary/search.
 * @returns {Promise<{ ok: boolean, status: number, items?: object[], total?: number, error?: string, bodySnippet?: string }>}
 */
async function ebayBrowseItemSummarySearch(accessToken, sandbox, { q, limit = 10, offset = 0 }) {
  const base = sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  const marketplaceId = ebayMarketplaceId();
  const params = new URLSearchParams({
    q: String(q || "gift").trim() || "gift",
    limit: String(Math.min(200, Math.max(1, limit))),
    offset: String(Math.max(0, offset)),
  });
  const url = `${base}/buy/browse/v1/item_summary/search?${params.toString()}`;
  const ctrl = new AbortController();
  // eBay Browse API kan være langsom fra dev-netværk/VPN; giv mere slack så health-check ikke fejler med HTTP 0.
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
        Accept: "application/json",
        "Accept-Language": ebayAcceptLanguage(),
      },
    });
    const text = await r.text();
    if (!r.ok) {
      const snippet = text ? String(text).replace(/\s+/g, " ").trim().slice(0, 220) : "";
      return { ok: false, status: r.status, error: snippet || `HTTP ${r.status}`, bodySnippet: snippet };
    }
    let j = {};
    try {
      j = JSON.parse(text);
    } catch {
      return { ok: false, status: r.status, error: "Ugyldig JSON fra Browse API" };
    }
    const items = Array.isArray(j.itemSummaries) ? j.itemSummaries : [];
    const total = j.total != null ? Number(j.total) : items.length;
    return { ok: true, status: r.status, items, total };
  } catch (e) {
    const msg = String(e && e.name === "AbortError" ? "Request timed out (aborted)" : e.message || e);
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Samme GET som discover, q=book&limit=1 — til forbindelsestjek. */
async function ebayBrowseSearchPing(accessToken, sandbox) {
  // eBay kan sporadisk returnere HTTP 500 (intern fejl) eller timeout (status=0).
  // Vi retry'er et par gange for at undgå falske negativer i health-check.
  const maxAttempts = 3;
  const queries = ["book", "gift", "shirt"];
  let last = null;
  for (let i = 0; i < maxAttempts; i++) {
    const q = queries[i] || queries[0];
    const res = await ebayBrowseItemSummarySearch(accessToken, sandbox, { q, limit: 1, offset: 0 });
    last = res;
    if (res.ok) return { ok: true, status: res.status };
    // Retry kun ved transiente fejl.
    const s = Number(res.status) || 0;
    if (!(s === 0 || s === 429 || s >= 500)) break;
    // tiny backoff: 400ms, 900ms ...
    await new Promise((r) => setTimeout(r, 400 + i * 500));
  }
  const res = last || { ok: false, status: 0, error: "unknown error" };
  return { ok: false, status: res.status, bodySnippet: res.bodySnippet, error: res.error };
}

module.exports = {
  ebaySandboxMode,
  ebayOAuthScopeString,
  ebayFetchApplicationAccessToken,
  ebayMarketplaceId,
  getEbayAccessTokenFromIntegrations,
  ebayBrowseItemSummarySearch,
  ebayBrowseSearchPing,
};
