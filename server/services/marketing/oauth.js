const crypto = require("crypto");
const { resolvePublicUrl } = require("../../lib/public-url");
const { createOauthState: createDbOauthState, consumeOauthState: consumeDbOauthState } = require("./connection-store");

const oauthStateStore = new Map();

function publicBaseUrl() {
  return resolvePublicUrl();
}

function gcOauthStates() {
  const now = Date.now();
  for (const [k, v] of oauthStateStore.entries()) {
    if (!v || Number(v.expiresAt) < now) oauthStateStore.delete(k);
  }
}

async function createOauthState(supabase, payload = {}) {
  if (supabase) {
    const dbState = await createDbOauthState(supabase, payload);
    if (dbState) return dbState;
  }
  gcOauthStates();
  const state = crypto.randomBytes(24).toString("hex");
  oauthStateStore.set(state, {
    ...payload,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return state;
}

async function consumeOauthState(supabase, state) {
  if (supabase) {
    const dbState = await consumeDbOauthState(supabase, state);
    if (dbState) return dbState;
  }
  gcOauthStates();
  const key = String(state || "");
  const row = oauthStateStore.get(key) || null;
  if (row) oauthStateStore.delete(key);
  return row;
}

function facebookAuthorizeUrl({ platform = "facebook", state }) {
  const clientId = String(process.env.META_APP_ID || "").trim();
  if (!clientId) return { ok: false, error: "Missing META_APP_ID" };
  const redirectUri = `${publicBaseUrl()}/api/admin/marketing/oauth/${encodeURIComponent(platform)}/callback`;
  const scope =
    platform === "instagram"
      ? String(process.env.META_INSTAGRAM_SCOPES || "pages_show_list,instagram_basic,instagram_content_publish").trim()
      : String(process.env.META_FACEBOOK_SCOPES || "pages_manage_posts,pages_show_list").trim();
  const url = new URL("https://www.facebook.com/v19.0/dialog/oauth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  return { ok: true, url: url.toString() };
}

async function exchangeFacebookCode({ code, platform = "facebook" }) {
  const clientId = String(process.env.META_APP_ID || "").trim();
  const clientSecret = String(process.env.META_APP_SECRET || "").trim();
  const redirectUri = `${publicBaseUrl()}/api/admin/marketing/oauth/${encodeURIComponent(platform)}/callback`;
  if (!clientId || !clientSecret) return { ok: false, error: "Missing META_APP_ID/META_APP_SECRET" };
  const tokenUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
  tokenUrl.searchParams.set("client_id", clientId);
  tokenUrl.searchParams.set("client_secret", clientSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", String(code || ""));
  const tokenRes = await fetch(tokenUrl.toString());
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) {
    return { ok: false, error: tokenData && tokenData.error && tokenData.error.message ? tokenData.error.message : "Facebook token exchange failed" };
  }
  const out = {
    ok: true,
    token: String(tokenData.access_token),
    expiresIn: Number(tokenData.expires_in) || null,
    pageId: "",
    igUserId: "",
  };

  try {
    const pagesUrl = new URL("https://graph.facebook.com/v19.0/me/accounts");
    pagesUrl.searchParams.set("access_token", out.token);
    pagesUrl.searchParams.set("fields", "id,name,instagram_business_account{id}");
    const pagesRes = await fetch(pagesUrl.toString());
    const pagesData = await pagesRes.json().catch(() => ({}));
    const first = Array.isArray(pagesData && pagesData.data) ? pagesData.data[0] : null;
    if (first && first.id) out.pageId = String(first.id);
    if (first && first.instagram_business_account && first.instagram_business_account.id) {
      out.igUserId = String(first.instagram_business_account.id);
    }
  } catch (_) {
    // best effort only
  }
  return out;
}

function tiktokAuthorizeUrl({ state }) {
  const clientKey = String(process.env.TIKTOK_CLIENT_KEY || "").trim();
  if (!clientKey) return { ok: false, error: "Missing TIKTOK_CLIENT_KEY" };
  const redirectUri = `${publicBaseUrl()}/api/admin/marketing/oauth/tiktok/callback`;
  const scope = String(process.env.TIKTOK_SCOPES || "user.info.basic,video.publish").trim();
  const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.searchParams.set("client_key", clientKey);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  return { ok: true, url: url.toString() };
}

async function exchangeTikTokCode({ code }) {
  const clientKey = String(process.env.TIKTOK_CLIENT_KEY || "").trim();
  const clientSecret = String(process.env.TIKTOK_CLIENT_SECRET || "").trim();
  const redirectUri = `${publicBaseUrl()}/api/admin/marketing/oauth/tiktok/callback`;
  if (!clientKey || !clientSecret) return { ok: false, error: "Missing TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET" };
  const body = new URLSearchParams();
  body.set("client_key", clientKey);
  body.set("client_secret", clientSecret);
  body.set("code", String(code || ""));
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", redirectUri);
  const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const tokenData = await tokenRes.json().catch(() => ({}));
  const accessToken = tokenData && tokenData.access_token ? String(tokenData.access_token) : "";
  if (!tokenRes.ok || !accessToken) {
    return { ok: false, error: tokenData && tokenData.error_description ? tokenData.error_description : "TikTok token exchange failed" };
  }
  return {
    ok: true,
    token: accessToken,
    accountId: String((tokenData && (tokenData.open_id || tokenData.union_id || tokenData.user_id)) || ""),
    refreshToken: String((tokenData && tokenData.refresh_token) || ""),
    expiresIn: Number(tokenData && tokenData.expires_in) || null,
  };
}

module.exports = {
  createOauthState,
  consumeOauthState,
  facebookAuthorizeUrl,
  exchangeFacebookCode,
  tiktokAuthorizeUrl,
  exchangeTikTokCode,
};
