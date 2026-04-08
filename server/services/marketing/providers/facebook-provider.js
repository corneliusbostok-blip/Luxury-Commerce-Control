const { BaseMarketingProvider } = require("./base-provider");

class FacebookProvider extends BaseMarketingProvider {
  platform() {
    return "facebook";
  }

  async publishPost(post, context = {}) {
    const token = String(context.token || "").trim();
    if (!token) return { ok: false, error: "missing_token", status: "failed" };
    const pageId = String(context.pageId || "me").trim();
    try {
      const body = new URLSearchParams();
      body.set("message", `${post.caption}\n\n${(post.hashtags || []).join(" ")}`.trim());
      body.set("access_token", token);
      if (post.image) body.set("link", post.image);
      const res = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(pageId)}/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || !data.id) {
        return { ok: false, status: "failed", error: (data && data.error && data.error.message) || "facebook_publish_failed" };
      }
      return { ok: true, status: "posted", id: data.id };
    } catch (e) {
      return { ok: false, status: "failed", error: String(e.message || e) };
    }
  }
}

module.exports = { FacebookProvider };
