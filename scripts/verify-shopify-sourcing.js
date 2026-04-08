/**
 * Offline verifikation af Shopify → discovery-kontrakt (ingen netværk som default).
 * Kør: npm run verify:shopify
 */
"use strict";

const assert = require("assert");
const path = require("path");

process.chdir(path.join(__dirname, ".."));

const {
  shopifyProductToDiscoveryCandidate,
  parseAdminLinkNext,
  extractMyshopifyHost,
} = require("../server/services/shopify-import");
const {
  fetchShopifyProductCandidates,
  isShopifySourcingActive,
} = require("../server/services/sourcing/providers/shopify");
const { normalizeSourcingBlock, enabledSourcesAllowWebScrape } = require("../server/services/sourcing/providers");

(() => {
  const link =
    '<https://x.myshopify.com/admin/api/2024-10/products.json?page_info=abc&limit=250>; rel="next", <https://x.myshopify.com/admin/api/2024-10/products.json?page_info=prev>; rel="previous"';
  const next = parseAdminLinkNext(link);
  assert.strictEqual(next, "https://x.myshopify.com/admin/api/2024-10/products.json?page_info=abc&limit=250");
  assert.strictEqual(parseAdminLinkNext(null), null);
  assert.strictEqual(parseAdminLinkNext('</z>; rel="previous"'), null);
})();

(() => {
  assert.strictEqual(enabledSourcesAllowWebScrape(null), true);
  assert.strictEqual(enabledSourcesAllowWebScrape({ enabledSources: [] }), true);
  assert.strictEqual(enabledSourcesAllowWebScrape({ enabledSources: ["shopify"] }), false);
  assert.strictEqual(enabledSourcesAllowWebScrape({ enabledSources: ["Web", "shopify"] }), true);
})();

(() => {
  const p = {
    id: 9001,
    title: "Linen Shirt",
    handle: "linen-shirt",
    body_html: "<p>Hi</p>",
    product_type: "Shirts",
    tags: ["summer"],
    vendor: "ACME",
    variants: [{ id: 1, price: "89.00" }],
    images: [{ src: "https://cdn.shopify.com/s/files/1/x.jpg" }],
  };
  const row = shopifyProductToDiscoveryCandidate(p, "https://velden.dk", "shopify_storefront_json");
  assert.strictEqual(row.title, "Linen Shirt");
  assert.strictEqual(row.importMethod, "shopify_storefront_json");
  assert.ok(row.price > 0);
  assert.strictEqual(row.image.startsWith("https://"), true);
  assert.match(row.externalId, /^shopify:velden\.dk:9001$/);
  assert.strictEqual(row.sourcePlatform, "Shopify");
  assert.ok(row.sourceUrl.includes("/products/linen-shirt"));
})();

(() => {
  assert.strictEqual(extractMyshopifyHost("https://foo.myshopify.com"), "foo.myshopify.com");
  assert.strictEqual(extractMyshopifyHost("https://custom.com"), null);
})();

(() => {
  const cfgOff = {
    enabledSources: [],
    sourcing: { providers: { shopify: { enabled: false, storeUrl: "https://a.dk", accessToken: "" } } },
  };
  assert.strictEqual(isShopifySourcingActive(cfgOff), false);
})();

(() => {
  const cfgOn = {
    enabledSources: [],
    sourcing: {
      providers: { shopify: { enabled: true, storeUrl: "https://b.dk", accessToken: "" } },
    },
  };
  assert.strictEqual(isShopifySourcingActive(cfgOn), true);
})();

(() => {
  const merged = normalizeSourcingBlock({
    providers: { shopify: { adminShopHost: "zap", collectionHandle: "/summer/" } },
  });
  const sh = merged.providers.shopify;
  assert.strictEqual(sh.adminShopHost, "zap.myshopify.com");
  assert.strictEqual(sh.collectionHandle, "summer");
})();

(() => {
  const cfgNoShopifySource = {
    enabledSources: ["web"],
    sourcing: {
      providers: { shopify: { enabled: true, storeUrl: "https://c.dk", accessToken: "" } },
    },
  };
  assert.strictEqual(isShopifySourcingActive(cfgNoShopifySource), false);
})();

(async () => {
  const empty = await fetchShopifyProductCandidates(3, { storeConfig: null });
  assert.deepStrictEqual(empty, []);
})();

(async () => {
  const cfg = {
    enabledSources: ["shopify"],
    sourcing: {
      providers: { shopify: { enabled: true, storeUrl: "", accessToken: "" } },
    },
  };
  const empty = await fetchShopifyProductCandidates(2, { storeConfig: cfg });
  assert.deepStrictEqual(empty, []);
})();

(() => {
  /** Defensive: manglende pris skal kastes tydeligt af parseFloat → bruges ikke som stille 0-pris i mapping. */
  const p = {
    id: 1,
    title: "X",
    handle: "x",
    variants: [{ price: "bad" }],
    images: [{ src: "https://i.jpg" }],
  };
  const row = shopifyProductToDiscoveryCandidate(p, "https://shop.dk", "shopify_api");
  assert.ok(!(row.price > 0));
})();

(() => {
  /**
   * Ugyldig origin: shopifyHostKey falder tilbage til "shop" (samme som import-rows),
   * så vi aldrig kaster på malformed base URL i mapping.
   */
  const p = {
    id: 2,
    title: "Y",
    handle: "y",
    variants: [{ price: "10" }],
    images: [{ src: "https://i.jpg" }],
  };
  const row = shopifyProductToDiscoveryCandidate(p, "not-a-valid-origin", "shopify_api");
  assert.strictEqual(row.externalId, "shopify:shop:2");
  assert.ok(row.price > 0);
})();

(() => {
  /** Rækker uden billede filtreres i fetchShopifyProductCandidates før return (discovery kræver image). */
  const p = { id: 3, title: "Z", handle: "z", variants: [{ price: "10" }], images: [] };
  const row = shopifyProductToDiscoveryCandidate(p, "https://ok.dk", "shopify_api");
  assert.strictEqual(String(row.image || "").trim(), "");
})();

console.log("verify-shopify-sourcing: all checks OK (%s)", new Date().toISOString());
