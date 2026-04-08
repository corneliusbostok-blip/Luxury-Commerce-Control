function trim(s, n) {
  return String(s || "").trim().slice(0, n);
}

function buildHashtags(input = {}) {
  const base = ["#luxury", "#premium", "#newdrop"];
  const category = String(input.category || "").toLowerCase().trim();
  if (category) base.push(`#${category.replace(/[^a-z0-9]/g, "")}`);
  const vibe = String(input.vibe || "")
    .split(/[,;\n]/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 3)
    .map((x) => `#${x.replace(/[^a-z0-9]/g, "")}`);
  return [...new Set([...base, ...vibe])].slice(0, 8);
}

function generateMarketingContent(input = {}) {
  const name = trim(input.name || input.title || "New product", 120);
  const price = input.price != null ? Number(input.price) : null;
  const season = trim(input.season || "", 40);
  const url = String(input.url || input.product_url || "").trim();
  let caption = (
    price && Number.isFinite(price)
      ? `${name} is now live. Crafted for modern taste${season ? ` · ${season}` : ""}. From ${price}. Explore details, fit and finish in our store now.`
      : `${name} is now live. Crafted for modern taste${season ? ` · ${season}` : ""}. Explore details, fit and finish in our store now.`
  ).trim();
  if (url) caption += ` Shop: ${url}`;
  const hashtags = buildHashtags(input);
  return {
    image: String(input.image || input.image_url || ""),
    caption: trim(caption, 520),
    hashtags,
    url,
  };
}

module.exports = { generateMarketingContent };
