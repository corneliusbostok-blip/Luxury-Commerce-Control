const crypto = require("crypto");

const SUPPORTED_PLATFORMS = new Set(["facebook", "instagram", "tiktok"]);
const DEFAULT_STORE_ID = "active";

function encKey() {
  const raw = String(process.env.MARKETING_TOKEN_ENC_KEY || "").trim();
  if (!raw) return null;
  const b = Buffer.from(raw, "base64");
  return b.length === 32 ? b : null;
}

function encryptToken(plain) {
  const key = encKey();
  const p = String(plain || "");
  if (!key || !p) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(p, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptToken(payload) {
  const key = encKey();
  const s = String(payload || "");
  if (!s) return "";
  if (!key) return s;
  try {
    const raw = Buffer.from(s, "base64");
    if (raw.length < 28) return "";
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return "";
  }
}

function normalizePlatform(platform) {
  const p = String(platform || "").toLowerCase();
  if (!SUPPORTED_PLATFORMS.has(p)) return "";
  return p;
}

async function listConnections(supabase, storeId = DEFAULT_STORE_ID) {
  if (!supabase) return [];
  const sid = String(storeId || DEFAULT_STORE_ID);
  const { data, error } = await supabase
    .from("marketing_connections")
    .select("id, store_id, platform, access_token_enc, refresh_token_enc, expires_at, account_id, page_id, ig_user_id, enabled, auth_method, connected_at, created_at, updated_at")
    .eq("store_id", sid)
    .in("platform", ["facebook", "instagram", "tiktok"]);
  if (error || !Array.isArray(data)) return [];
  return data.map((r) => ({
    ...r,
    access_token: decryptToken(r.access_token_enc),
    refresh_token: decryptToken(r.refresh_token_enc),
  }));
}

async function getConnection(supabase, platform, storeId = DEFAULT_STORE_ID) {
  if (!supabase) return null;
  const p = normalizePlatform(platform);
  if (!p) return null;
  const sid = String(storeId || DEFAULT_STORE_ID);
  const { data } = await supabase
    .from("marketing_connections")
    .select("id, store_id, platform, access_token_enc, refresh_token_enc, expires_at, account_id, page_id, ig_user_id, enabled, auth_method, connected_at, created_at, updated_at")
    .eq("store_id", sid)
    .eq("platform", p)
    .maybeSingle();
  if (!data) return null;
  return {
    ...data,
    access_token: decryptToken(data.access_token_enc),
    refresh_token: decryptToken(data.refresh_token_enc),
  };
}

async function upsertConnection(supabase, input = {}) {
  if (!supabase) return { ok: false, error: "no_db" };
  const p = normalizePlatform(input.platform);
  if (!p) return { ok: false, error: "unsupported_platform" };
  const sid = String(input.store_id || DEFAULT_STORE_ID);
  const accessToken = String(input.access_token || "").trim();
  const refreshToken = String(input.refresh_token || "").trim();
  const row = {
    store_id: sid,
    platform: p,
    access_token_enc: accessToken ? (encryptToken(accessToken) || accessToken) : "",
    refresh_token_enc: refreshToken ? (encryptToken(refreshToken) || refreshToken) : "",
    expires_at: input.expires_at || null,
    account_id: String(input.account_id || "").trim(),
    page_id: String(input.page_id || "").trim(),
    ig_user_id: String(input.ig_user_id || "").trim(),
    enabled: input.enabled !== false,
    auth_method: String(input.auth_method || "").trim(),
    connected_at: input.connected_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from("marketing_connections")
    .upsert(row, { onConflict: "store_id,platform" });
  if (error) return { ok: false, error: error.message || "connection_upsert_failed" };
  return { ok: true };
}

async function markConnectionDisconnected(supabase, platform, storeId = DEFAULT_STORE_ID) {
  if (!supabase) return { ok: false, error: "no_db" };
  const p = normalizePlatform(platform);
  if (!p) return { ok: false, error: "unsupported_platform" };
  const sid = String(storeId || DEFAULT_STORE_ID);
  const { error } = await supabase
    .from("marketing_connections")
    .upsert({
      store_id: sid,
      platform: p,
      access_token_enc: "",
      refresh_token_enc: "",
      expires_at: null,
      account_id: "",
      page_id: "",
      ig_user_id: "",
      enabled: false,
      auth_method: "",
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "store_id,platform" });
  if (error) return { ok: false, error: error.message || "connection_disconnect_failed" };
  return { ok: true };
}

async function createOauthState(supabase, payload = {}) {
  if (!supabase) return "";
  const platform = normalizePlatform(payload.platform);
  if (!platform) return "";
  const state = crypto.randomBytes(24).toString("hex");
  const storeId = String(payload.store_id || DEFAULT_STORE_ID);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { error } = await supabase.from("marketing_oauth_states").insert({
    state,
    store_id: storeId,
    platform,
    expires_at: expiresAt,
    used_at: null,
  });
  if (error) return "";
  return state;
}

async function consumeOauthState(supabase, stateRaw) {
  if (!supabase) return null;
  const state = String(stateRaw || "");
  if (!state) return null;
  const { data } = await supabase
    .from("marketing_oauth_states")
    .select("state, store_id, platform, expires_at, used_at, created_at")
    .eq("state", state)
    .maybeSingle();
  if (!data) return null;
  if (data.used_at) return null;
  if (Date.parse(String(data.expires_at || "")) < Date.now()) return null;
  await supabase
    .from("marketing_oauth_states")
    .update({ used_at: new Date().toISOString() })
    .eq("state", state)
    .is("used_at", null);
  return data;
}

module.exports = {
  DEFAULT_STORE_ID,
  listConnections,
  getConnection,
  upsertConnection,
  markConnectionDisconnected,
  createOauthState,
  consumeOauthState,
};

