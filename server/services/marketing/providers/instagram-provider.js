const { BaseMarketingProvider } = require("./base-provider");

class InstagramProvider extends BaseMarketingProvider {
  platform() {
    return "instagram";
  }

  async publishPost(post, context = {}) {
    const token = String(context.token || "").trim();
    const igUserId = String(context.igUserId || context.accountId || "").trim();
    if (!token) return { ok: false, status: "failed", error: "missing_token" };
    if (!igUserId) return { ok: false, status: "failed", error: "missing_ig_user_id" };
    if (!post.image) return { ok: false, status: "failed", error: "missing_image_for_instagram" };
    try {
      const mediaParams = new URLSearchParams();
      mediaParams.set("image_url", post.image);
      mediaParams.set("caption", `${post.caption}\n\n${(post.hashtags || []).join(" ")}`.trim());
      mediaParams.set("access_token", token);
      const createRes = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(igUserId)}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: mediaParams.toString(),
      });
      const createData = await createRes.json().catch(() => ({}));
      if (!createRes.ok || !createData || !createData.id) {
        return { ok: false, status: "failed", error: (createData && createData.error && createData.error.message) || "instagram_media_create_failed" };
      }

      const publishParams = new URLSearchParams();
      publishParams.set("creation_id", createData.id);
      publishParams.set("access_token", token);
      const pubRes = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(igUserId)}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: publishParams.toString(),
      });
      const pubData = await pubRes.json().catch(() => ({}));
      if (!pubRes.ok || !pubData || !pubData.id) {
        return { ok: false, status: "failed", error: (pubData && pubData.error && pubData.error.message) || "instagram_publish_failed" };
      }
      return { ok: true, status: "posted", id: pubData.id };
    } catch (e) {
      return { ok: false, status: "failed", error: String(e.message || e) };
    }
  }
}

module.exports = { InstagramProvider };
