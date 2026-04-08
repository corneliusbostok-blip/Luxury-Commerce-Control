const { FacebookProvider } = require("./facebook-provider");
const { InstagramProvider } = require("./instagram-provider");
const { TikTokProvider } = require("./tiktok-provider");

function defaultMarketingProviders() {
  return [new FacebookProvider(), new InstagramProvider(), new TikTokProvider()];
}

function providerByPlatform(platform) {
  const p = String(platform || "").toLowerCase();
  return defaultMarketingProviders().find((x) => x.platform() === p) || null;
}

module.exports = { defaultMarketingProviders, providerByPlatform };
