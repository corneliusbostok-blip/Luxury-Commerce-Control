/**
 * Velden eBay checkout / listing autofill
 *
 * Runs ONLY when:
 *   1) Hostname looks like eBay (*.ebay.*), and
 *   2) URL query contains velden_data (base64url JSON from Velden admin "Buy on eBay").
 *
 * eBay will NOT load this file by itself — inject it once per session:
 *
 * --- Tampermonkey (recommended) ---
 * New script → paste the block below, then paste this entire file under it:
 *
 * // ==UserScript==
 * // @name         Velden eBay Autofill
 * // @namespace    https://velden.local/
 * // @version      1
 * // @match        *://*.ebay.com/*
 * // @match        *://*.ebay.co.uk/*
 * // @match        *://*.ebay.de/*
 * // @grant        none
 * // @run-at       document-idle
 * // ==/UserScript==
 *
 * --- Bookmarklet (replace ORIGIN with your Velden site, e.g. https://app.example.com) ---
 * javascript:(function(){var s=document.createElement("script");s.src="ORIGIN/js/ebay-autofill.js";(document.body||document.documentElement).appendChild(s);})();
 *
 * After opening a listing/checkout URL from admin, click the bookmarklet if you are not using Tampermonkey.
 */
(function veldenEbayAutofill() {
  "use strict";

  var EBAY_RE = /\.ebay\.(com|co\.uk|de|fr|it|es|com\.au|nl|ca|ch|at|ie|be|pl)(:\d+)?$/i;

  function isEbayHost() {
    try {
      return EBAY_RE.test(location.hostname) || /^ebay\./i.test(location.hostname);
    } catch (e) {
      return false;
    }
  }

  if (!isEbayHost()) return;

  function readVeldenParam() {
    try {
      return new URLSearchParams(location.search).get("velden_data");
    } catch (e) {
      return null;
    }
  }

  var rawParam = readVeldenParam();
  if (!rawParam) return;

  function decodePayload(b64url) {
    try {
      var b64 = String(b64url).replace(/-/g, "+").replace(/_/g, "/");
      var pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
      var bin = atob(b64 + pad);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var json = new TextDecoder("utf-8").decode(bytes);
      return JSON.parse(json);
    } catch (e) {
      console.warn("[velden-ebay-autofill] Could not decode velden_data:", e);
      return null;
    }
  }

  var data = decodePayload(rawParam);
  if (!data || typeof data !== "object") return;

  function splitName(full) {
    var s = String(full || "").trim();
    if (!s) return { first: "", last: "" };
    var i = s.indexOf(" ");
    if (i === -1) return { first: s, last: "" };
    return { first: s.slice(0, i).trim(), last: s.slice(i + 1).trim() };
  }

  function setNativeInputValue(el, value) {
    if (el == null || value == null) return;
    var v = String(value);
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setSelectByMatch(select, needle) {
    if (!select || !needle) return false;
    var n = String(needle).trim().toLowerCase();
    if (!n) return false;
    var opts = select.querySelectorAll ? select.querySelectorAll("option") : [];
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      var t = (o.textContent || "").trim().toLowerCase();
      var val = (o.value || "").trim().toLowerCase();
      if (t.indexOf(n) >= 0 || val.indexOf(n) >= 0 || n.indexOf(t) >= 0) {
        select.value = o.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  function queryFirst(selectors) {
    for (var s = 0; s < selectors.length; s++) {
      try {
        var el = document.querySelector(selectors[s]);
        if (el) return el;
      } catch (e) {
        /* ignore invalid selector */
      }
    }
    return null;
  }

  function fillInput(selectors, value, label) {
    if (value == null || String(value).trim() === "") return true;
    var el = queryFirst(selectors);
    if (!el) {
      console.warn("[velden-ebay-autofill] Field not found:", label);
      return false;
    }
    setNativeInputValue(el, value);
    return true;
  }

  function fillCountry(value) {
    if (value == null || String(value).trim() === "") return true;
    var selectors = [
      'select[name="country"]',
      'select[name="countryId"]',
      'select[id*="country" i]',
      'select[name*="country" i]',
    ];
    var sel = queryFirst(selectors);
    if (sel && sel.tagName === "SELECT") {
      if (setSelectByMatch(sel, value)) return true;
    }
    if (fillInput(['input[name="country"]', 'input[id*="country" i]'], value, "country")) return true;
    console.warn("[velden-ebay-autofill] Field not found: country");
    return false;
  }

  function clickOrSelectVariant(needle) {
    if (!needle || String(needle).trim() === "") return true;
    var n = String(needle).trim().toLowerCase();

    var selects = document.querySelectorAll("select");
    for (var i = 0; i < selects.length; i++) {
      if (setSelectByMatch(selects[i], needle)) return true;
    }

    var radios = document.querySelectorAll('input[type="radio"]');
    for (var r = 0; r < radios.length; r++) {
      var rad = radios[r];
      var lbl = "";
      if (rad.id) {
        var lab = document.querySelector('label[for="' + rad.id.replace(/"/g, '\\"') + '"]');
        if (lab) lbl = (lab.textContent || "").trim().toLowerCase();
      }
      var val = (rad.value || "").toLowerCase();
      var name = (rad.name || "").toLowerCase();
      if (
        (name.indexOf("msku") >= 0 || name.indexOf("variation") >= 0 || lbl) &&
        (val.indexOf(n) >= 0 || lbl.indexOf(n) >= 0 || n.indexOf(val) >= 0)
      ) {
        rad.click();
        rad.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    var buttons = document.querySelectorAll("button, a[role='button'], [role='button']");
    for (var b = 0; b < buttons.length; b++) {
      var btn = buttons[b];
      var txt = (btn.textContent || btn.getAttribute("aria-label") || "").trim().toLowerCase();
      if (txt && (txt === n || txt.indexOf(n) >= 0 || n.indexOf(txt) >= 0)) {
        btn.click();
        return true;
      }
    }

    console.warn("[velden-ebay-autofill] Variant control not found for:", needle);
    return false;
  }

  var names = splitName(data.name || data.fullName || "");

  var FIELD_SPECS = [
    {
      key: "firstName",
      value: data.firstName || names.first,
      selectors: [
        'input[name="firstName"]',
        'input[id*="firstName" i]',
        'input[autocomplete="given-name"]',
      ],
    },
    {
      key: "lastName",
      value: data.lastName || names.last,
      selectors: [
        'input[name="lastName"]',
        'input[id*="lastName" i]',
        'input[autocomplete="family-name"]',
      ],
    },
    {
      key: "addressLine1",
      value: data.addressLine1 || data.address,
      selectors: [
        'input[name="addressLine1"]',
        'input[name="address1"]',
        'input[id*="addressLine1" i]',
        'input[autocomplete="address-line1"]',
      ],
    },
    {
      key: "city",
      value: data.city,
      selectors: [
        'input[name="city"]',
        'input[id*="city" i]',
        'input[autocomplete="address-level2"]',
      ],
    },
    {
      key: "postalCode",
      value: data.postalCode || data.zip,
      selectors: [
        'input[name="postalCode"]',
        'input[name="zip"]',
        'input[id*="postal" i]',
        'input[autocomplete="postal-code"]',
      ],
    },
  ];

  var filled = Object.create(null);

  function runPass() {
    for (var i = 0; i < FIELD_SPECS.length; i++) {
      var spec = FIELD_SPECS[i];
      if (filled[spec.key]) continue;
      if (fillInput(spec.selectors, spec.value, spec.key)) filled[spec.key] = true;
    }
    if (!filled.country) {
      if (fillCountry(data.country)) filled.country = true;
    }
    if (data.size && !filled.variantSize) {
      if (clickOrSelectVariant(data.size)) filled.variantSize = true;
    }
    if (data.color && !filled.variantColor) {
      if (clickOrSelectVariant(data.color)) filled.variantColor = true;
    }
  }

  var maxTicks = 60;
  var tick = 0;
  var interval = setInterval(function () {
    tick++;
    try {
      runPass();
    } catch (e) {
      console.warn("[velden-ebay-autofill] Pass error (non-fatal):", e);
    }
    if (tick >= maxTicks) clearInterval(interval);
  }, 500);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      try {
        runPass();
      } catch (e) {
        console.warn("[velden-ebay-autofill] DOMContentLoaded error:", e);
      }
    });
  } else {
    try {
      runPass();
    } catch (e) {
      console.warn("[velden-ebay-autofill] Initial run error:", e);
    }
  }

  try {
    var obs = new MutationObserver(function () {
      try {
        runPass();
      } catch (e) {
        /* ignore */
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function () {
      try {
        obs.disconnect();
      } catch (e) {
        /* ignore */
      }
    }, 30000);
  } catch (e) {
    /* MutationObserver unavailable */
  }
})();
