const { BaseMarketingProvider } = require("./base-provider");

const TIKTOK_CONTENT_INIT = "https://open.tiktokapis.com/v2/post/publish/content/init/";
const MAX_ATTEMPTS = 4;

function clip(s, max) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + "…";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {Response} res
 * @param {object} data
 * @returns {{ errorClass: string, retryable: boolean, detail: string }}
 */
function classifyTiktokFailure(res, data) {
  const status = res && typeof res.status === "number" ? res.status : 0;
  const apiErr = data && data.error;
  const code = apiErr && apiErr.code != null ? String(apiErr.code) : "";
  const msg = apiErr && apiErr.message != null ? String(apiErr.message) : "";
  const combined = `${code} ${msg}`.toLowerCase();

  if (status === 401 || status === 403) {
    return { errorClass: "auth_error", retryable: false, detail: msg || `http_${status}` };
  }
  if (status === 429 || /rate_limit|too_many|quota/i.test(combined)) {
    return { errorClass: "rate_limit", retryable: true, detail: msg || code || `http_${status}` };
  }
  if (
    /access_token|invalid_token|invalid_grant|scope_not|unauthor|expired_token|token_revoked/i.test(combined) ||
    /invalid_access_token|access_token_invalid/i.test(code)
  ) {
    return { errorClass: "auth_error", retryable: false, detail: msg || code || `http_${status}` };
  }
  if (
    /invalid_param|validation|url_ownership|spam_risk|forbidden|bad_request|not_found/i.test(combined) ||
    (status >= 400 && status < 500 && status !== 429)
  ) {
    return { errorClass: "validation_error", retryable: false, detail: msg || code || `http_${status}` };
  }
  if (status >= 500) {
    return { errorClass: "unknown", retryable: true, detail: msg || `http_${status}` };
  }
  return { errorClass: "unknown", retryable: false, detail: msg || code || `http_${status}` };
}

/**
 * TikTok Content Posting API — PHOTO direct post via PULL_FROM_URL.
 * Requires OAuth scope video.publish (or video.upload per TikTok docs) and a public HTTPS image URL.
 * @see https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
 */
class TikTokProvider extends BaseMarketingProvider {
  platform() {
    return "tiktok";
  }

  async dryRunPost(post, context = {}) {
    const token = String((context && context.token) || "").trim();
    if (!token) return { ok: false, status: "preview", error: "missing_token", errorClass: "auth_error" };
    const imageUrl = String((post && post.image) || "").trim();
    if (!/^https:\/\//i.test(imageUrl)) {
      return {
        ok: false,
        status: "preview",
        error: "tiktok_photo_requires_public_https_image_url",
        errorClass: "validation_error",
      };
    }
    return { ok: true, id: `dry_tiktok_${Date.now()}`, status: "preview" };
  }

  async publishPost(post, context = {}) {
    const token = String((context && context.token) || "").trim();
    if (!token) {
      return { ok: false, status: "failed", error: "[auth_error] missing_token", errorClass: "auth_error", attempts: 0 };
    }

    const imageUrl = String((post && post.image) || "").trim();
    if (!/^https:\/\//i.test(imageUrl)) {
      return {
        ok: false,
        status: "failed",
        error: "[validation_error] tiktok_photo_requires_public_https_image_url",
        errorClass: "validation_error",
        attempts: 0,
      };
    }

    const hashtags = Array.isArray(post.hashtags) ? post.hashtags.join(" ") : "";
    const description = clip(`${post.caption || ""}\n\n${hashtags}`.trim(), 4000) || " ";
    const title = clip(post.caption || post.title || "New arrival", 90);
    const privacyLevel = String(process.env.TIKTOK_PRIVACY_LEVEL || "PUBLIC_TO_EVERYONE").trim();

    const body = {
      media_type: "PHOTO",
      post_mode: "DIRECT_POST",
      post_info: {
        title,
        description,
        privacy_level: privacyLevel,
        disable_comment: false,
        auto_add_music: true,
      },
      source_info: {
        source: "PULL_FROM_URL",
        photo_images: [imageUrl],
        photo_cover_index: 0,
      },
    };

    let last = {
      ok: false,
      status: "failed",
      error: "[unknown] tiktok_publish_failed",
      errorClass: "unknown",
      attempts: 0,
    };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      last.attempts = attempt + 1;
      try {
        const res = await fetch(TIKTOK_CONTENT_INIT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=UTF-8",
          },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        const apiErr = data && data.error;
        const errCode = apiErr && apiErr.code != null ? String(apiErr.code) : "";
        const publishId = data && data.data && data.data.publish_id ? String(data.data.publish_id) : "";
        const httpOk = res.ok;
        const apiOk = !errCode || errCode.toLowerCase() === "ok";

        if (httpOk && apiOk && publishId) {
          return { ok: true, status: "posted", id: publishId, attempts: last.attempts, errorClass: null };
        }

        let c;
        if (httpOk && apiOk && !publishId) {
          c = { errorClass: "validation_error", retryable: false, detail: "tiktok_missing_publish_id" };
        } else {
          c = classifyTiktokFailure(res, data);
        }

        last = {
          ok: false,
          status: "failed",
          error: `[${c.errorClass}] ${c.detail}`,
          errorClass: c.errorClass,
          attempts: last.attempts,
        };
        if (!c.retryable) break;
        if (attempt < MAX_ATTEMPTS - 1) {
          const backoff = Math.min(30_000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250);
          await sleep(backoff);
        }
      } catch (e) {
        const detail = String(e && e.message ? e.message : e);
        last = {
          ok: false,
          status: "failed",
          error: `[unknown] ${detail}`,
          errorClass: "unknown",
          attempts: last.attempts,
        };
        if (attempt < MAX_ATTEMPTS - 1) {
          const backoff = Math.min(30_000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250);
          await sleep(backoff);
        }
      }
    }

    return last;
  }
}

module.exports = { TikTokProvider };
