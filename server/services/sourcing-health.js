/**
 * Live check: kan automation faktisk hente data fra de valgte leverandører?
 * Bruges af GET /api/admin/sourcing-health (fuld store config serverside).
 */
const {
  isWebDiscoveryEnabled,
  enabledSourcesAllowWebScrape,
  isShopifySourcingActive,
  ebayIntegrationConfigured,
} = require("./sourcing/providers");
const { ebaySandboxMode, ebayBrowseSearchPing, ebayFetchApplicationAccessToken } = require("./ebay-api");
const { resolveDiscoverySeeds } = require("./discovery");
const { resolveShopifyFetchTarget, fetchShopifyProductsUpTo } = require("./shopify-import");

const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT =
  process.env.DISCOVERY_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function canonicalSources(storeConfig) {
  const cfg = storeConfig || {};
  const raw = Array.isArray(cfg.enabledSources) ? cfg.enabledSources : [];
  const tokens = raw.map((s) => String(s || "").toLowerCase().trim()).filter(Boolean);
  const set = new Set();
  if (!tokens.length) {
    set.add("web");
    if (isShopifySourcingActive(cfg)) set.add("shopify");
    if (ebayIntegrationConfigured(cfg)) set.add("ebay");
    return [...set];
  }
  for (const t of tokens) {
    if (["web", "http", "https", "discovery", "scrape"].includes(t)) set.add("web");
    else if (t.includes("shopify")) set.add("shopify");
    else if (t.includes("ebay")) set.add("ebay");
    else if (t.includes("alibaba")) set.add("alibaba");
    else if (t.includes("cj")) set.add("cjdropshipping");
  }
  return [...set];
}

async function fetchOk(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(String(url).split("#")[0], {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,da;q=0.8",
      },
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function ebayConfigured(integrations) {
  const e = integrations && integrations.ebay;
  if (!e) return false;
  const id = String(e.clientId || "").trim();
  const secret = String(e.clientSecret || "").trim();
  const oauth = String(e.oauthToken || "").trim();
  return Boolean(id && (secret || oauth));
}

/**
 * @param {object} integrations — fuld store_config.integrations (serverside, med hemmeligheder).
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function testEbayConnection(integrations) {
  const e = integrations && integrations.ebay;
  if (!e) return { ok: false, message: "eBay-integration mangler." };
  const clientId = String(e.clientId || "").trim();
  if (!clientId) return { ok: false, message: "eBay App ID (Client ID) mangler." };

  const clientSecret = String(e.clientSecret || "").trim();
  const userToken = String(e.oauthToken || "").trim();

  if (clientSecret) {
    const sandbox = ebaySandboxMode(clientId);
    const tok = await ebayFetchApplicationAccessToken(clientId, clientSecret, sandbox);
    if (!tok.ok) {
      const hint =
        tok.status === 401 || /invalid_client/i.test(String(tok.error || ""))
          ? ` Tjek Client Secret. App ID med «-SBX-» bruger automatisk sandbox-API; ellers sæt EBAY_USE_SANDBOX=true. Production-nøgler kræver production-endpoint.`
          : "";
      return {
        ok: false,
        message: `eBay afviste client credentials (HTTP ${tok.status}): ${String(tok.error || "").slice(0, 280)}.${hint}`,
      };
    }
    const ping = await ebayBrowseSearchPing(tok.accessToken, sandbox);
    if (ping.ok) {
      return {
        ok: true,
        message:
          "OK — OAuth (client credentials) og Browse API. Slå «Automatisk import» til under eBay og gem — så kan AI hente vareforslag via Browse API (sammen med web/Shopify).",
      };
    }
    const extra =
      ping.bodySnippet && ping.status >= 400
        ? ` eBay sagde: «${ping.bodySnippet}»`
        : ping.error
          ? ` (${ping.error})`
          : "";
    const mpHint =
      ping.status === 403 || ping.status === 401
        ? " Prøv EBAY_MARKETPLACE_ID=EBAY_DE (eller den markedsplads I bruger) og tjek under developer.ebay.com → Application Keys at nøglesættet har OAuth-scopes til Browse API."
        : "";
    return {
      ok: false,
      message: `OAuth-token modtaget, men Browse API-test fejlede (HTTP ${ping.status}).${extra}${mpHint} Tip: hvis du ser “This operation was aborted”, så er det typisk timeout/netværk — prøv igen, eller hæv timeout / skift netværk. (Valgfrit i .env: EBAY_MARKETPLACE_ID, EBAY_OAUTH_SCOPE fra jeres «OAuth scopes»-eksempel.)`,
    };
  }

  if (userToken) {
    const sandbox = ebaySandboxMode(clientId);
    const ping = await ebayBrowseSearchPing(userToken, sandbox);
    if (!ping.ok) {
      const extra =
        ping.bodySnippet && ping.status >= 400
          ? ` «${ping.bodySnippet}»`
          : ping.error || "";
      return {
        ok: false,
        message: `Bearer-token (OAuth-felt) fejlede mod Browse API (HTTP ${ping.status}).${extra ? " " + extra : ""} Ofte udløbet token — brug eBays Authorization Code flow og indsæt en frisk token, eller brug Client ID + Client Secret under Integrationer (gemmes i Supabase) til application-token.`,
      };
    }
    return {
      ok: true,
      message:
        "OK — Bruger-/app-token accepteres af Browse API. Slå «Automatisk import» til for at hente varer til sourcing.",
    };
  }

  return {
    ok: false,
    message:
      "eBay kræver App ID (Client ID) + Client secret eller OAuth-token under Indstillinger → Markedspladser (gemmes i databasen — ikke i .env).",
  };
}

function alibabaConfigured(integrations) {
  const a = integrations && integrations.alibaba;
  if (!a) return false;
  const key = String(a.appKey || "").trim();
  const sec = String(a.appSecret || "").trim();
  const tok = String(a.accessToken || "").trim();
  return Boolean(key && sec && tok);
}

/**
 * @param {object | null} storeConfig
 * @returns {Promise<{ ok: boolean, checkedAt: string, sources: object[], logLines: string[] }>}
 */
async function runSourcingHealthChecks(storeConfig) {
  const cfg = storeConfig || {};
  const integrations = cfg.integrations || {};
  const sources = canonicalSources(cfg);
  const results = [];
  const logLines = [];

  for (const id of sources) {
    if (id === "web") {
      if (!isWebDiscoveryEnabled(cfg)) {
        const msg = "Web-provider er slået fra (sourcing.providers.web.enabled).";
        logLines.push(`[web] ✗ ${msg}`);
        results.push({ id, ok: false, message: msg });
        continue;
      }
      if (!enabledSourcesAllowWebScrape(cfg)) {
        const msg = "HTTP-discovery er ikke valgt under «Leverandører / kilder» (tilføj web).";
        logLines.push(`[web] ✗ ${msg}`);
        results.push({ id, ok: false, message: msg });
        continue;
      }
      const seeds = resolveDiscoverySeeds({ storeConfig: cfg, chatMode: false });
      if (!seeds.length) {
        const msg =
          "Ingen seed-URL: sæt DISCOVERY_SEED_URLS / DISCOVERY_SEED_* i miljø eller web.seedUrls / seedsByCategory (for dine kategorier).";
        logLines.push(`[web] ✗ ${msg}`);
        results.push({ id, ok: false, message: msg });
        continue;
      }
      const probe = await fetchOk(seeds[0]);
      if (!probe.ok) {
        const msg = probe.status
          ? `Kunne ikke hente seed (${probe.status}): ${seeds[0].slice(0, 120)}`
          : `Netværksfejl mod seed: ${probe.error || "timeout"} · ${seeds[0].slice(0, 120)}`;
        logLines.push(`[web] ✗ ${msg}`);
        results.push({ id, ok: false, message: msg, sampleUrl: seeds[0] });
        continue;
      }
      const okMsg = `OK — ${seeds.length} seed(s); første svar HTTP ${probe.status}`;
      logLines.push(`[web] ✓ ${okMsg}`);
      results.push({ id, ok: true, message: okMsg, seedCount: seeds.length });
      continue;
    }

    if (id === "shopify") {
      if (!isShopifySourcingActive(cfg)) {
        const msg =
          "Shopify er ikke aktiv: vælg «shopify» under kilder, slå provider til, og angiv https-butiks-URL.";
        logLines.push(`[shopify] ✗ ${msg}`);
        results.push({ id, ok: false, message: msg });
        continue;
      }
      const p = cfg.sourcing.providers.shopify;
      const storeUrl = String(p.storeUrl || "").trim();
      const resolved = resolveShopifyFetchTarget(storeUrl);
      if (resolved.error) {
        const msg = `Ugyldig Shopify-URL: ${resolved.error}`;
        logLines.push(`[shopify] ✗ ${msg}`);
        results.push({ id, ok: false, message: msg });
        continue;
      }
      const handle = String(p.collectionHandle || "").trim() || resolved.collectionHandle || null;
      try {
        const products = await fetchShopifyProductsUpTo(resolved.origin, handle, 1);
        if (!products.length) {
          const msg = handle
            ? `Ingen produkter i kollektion «${handle}» (eller tom storefront JSON).`
            : "Ingen produkter fra /products.json (tom eller blokeret).";
          logLines.push(`[shopify] ✗ ${msg}`);
          results.push({ id, ok: false, message: msg });
        } else {
          const okMsg = `OK — product feed (${handle ? `collection ${handle}` : "storefront"})`;
          logLines.push(`[shopify] ✓ ${okMsg}`);
          results.push({ id, ok: true, message: okMsg });
        }
      } catch (e) {
        const msg = String(e.message || e);
        logLines.push(`[shopify] ✗ ${msg}`);
        results.push({ id, ok: false, message: msg });
      }
      continue;
    }

    if (id === "ebay") {
      if (!ebayConfigured(integrations)) {
        const msg =
          "eBay: udfyld App ID (Client ID) og enten Client secret eller OAuth-token under Indstillinger → Markedspladser (gemmes i Supabase — ikke samme nøgle som SUPABASE_SERVICE_ROLE_KEY).";
        logLines.push(`[ebay] ✗ ${msg}`);
        results.push({ id, ok: false, message: msg });
      } else {
        const test = await testEbayConnection(integrations);
        if (test.ok) {
          logLines.push(`[ebay] ✓ ${test.message}`);
          results.push({ id, ok: true, message: test.message });
        } else {
          logLines.push(`[ebay] ✗ ${test.message}`);
          results.push({ id, ok: false, message: test.message });
        }
      }
      continue;
    }

    if (id === "alibaba") {
      if (!alibabaConfigured(integrations)) {
        const msg = "Alibaba kræver appKey, appSecret og accessToken under Integrationer.";
        logLines.push(`[alibaba] ✗ ${msg}`);
        results.push({ id, ok: false, message: msg });
      } else {
        const msg =
          "API-oplysninger er udfyldt, men serveren har endnu ikke koblet automatisk katalog-hentning til Alibaba (kun felt-tjek).";
        logLines.push(`[alibaba] ✗ ${msg}`);
        results.push({ id, ok: false, message: msg });
      }
      continue;
    }

    if (id === "cjdropshipping") {
      const msg =
        "CJ Dropshipping er valgt som kilde, men automatisk katalog-hentning via CJ er endnu ikke koblet til discovery.";
      logLines.push(`[cjdropshipping] ✗ ${msg}`);
      results.push({ id, ok: false, message: msg });
    }
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  return {
    ok,
    checkedAt: new Date().toISOString(),
    sources: results,
    logLines,
  };
}

module.exports = {
  runSourcingHealthChecks,
  canonicalSources,
};
