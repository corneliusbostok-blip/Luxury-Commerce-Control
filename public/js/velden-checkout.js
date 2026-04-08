/**
 * Dedikeret checkout: ordreoversigt + leveringsformular → Stripe (POST /api/checkout/cart).
 * Kræver VeldenCart + #checkout-root i DOM.
 */
(function () {
  var root = document.getElementById("checkout-root");
  if (!root) return;
  var apiClient = window.VeldenApiClient && window.VeldenApiClient.request;

  var shippingMeta = null;
  var selectedShip = "DK";
  var SHIPPING_FALLBACK = {
    countries: [
      { code: "DK", name: "Danmark", amountMajor: 49 },
      { code: "SE", name: "Sverige", amountMajor: 89 },
      { code: "NO", name: "Norge", amountMajor: 89 },
      { code: "FI", name: "Finland", amountMajor: 89 },
      { code: "DE", name: "Tyskland", amountMajor: 69 },
      { code: "NL", name: "Holland", amountMajor: 69 },
      { code: "FR", name: "Frankrig", amountMajor: 69 },
      { code: "IT", name: "Italien", amountMajor: 69 },
      { code: "ES", name: "Spanien", amountMajor: 69 },
      { code: "PL", name: "Polen", amountMajor: 69 },
      { code: "AT", name: "Ostrig", amountMajor: 69 },
      { code: "BE", name: "Belgien", amountMajor: 69 },
      { code: "CH", name: "Schweiz", amountMajor: 129 },
      { code: "GB", name: "Storbritannien", amountMajor: 129 },
      { code: "US", name: "USA", amountMajor: 129 },
      { code: "CA", name: "Canada", amountMajor: 129 },
      { code: "AU", name: "Australien", amountMajor: 129 },
    ],
  };

  function fmt(n) {
    return new Intl.NumberFormat("da-DK", {
      style: "currency",
      currency: "DKK",
      maximumFractionDigits: 0,
    }).format(n);
  }

  function shipAmountFor(code) {
    var list = (shippingMeta && shippingMeta.countries) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].code === code) return Number(list[i].amountMajor) || 0;
    }
    return 0;
  }

  function apiRequest(url, options) {
    if (apiClient) return apiClient(url, options || {});
    return fetch(url, options || {})
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok && (j.ok !== false), status: r.status, data: j, message: j.message || j.error };
        });
      })
      .catch(function (e) {
        return { ok: false, status: 0, data: null, message: (e && e.message) || "Netvaerksfejl" };
      });
  }

  function setCheckoutFeedback(message, tone) {
    var el = document.getElementById("checkout-feedback");
    if (!el) return;
    el.textContent = message || "";
    el.style.display = message ? "block" : "none";
    el.style.color = tone === "error" ? "#9b2c2c" : "#2f4f3e";
  }

  function healthInnerPayload(resp) {
    var wrap = resp.data || {};
    return wrap.data && typeof wrap.data === "object" ? wrap.data : wrap;
  }

  function refreshCheckoutReadiness() {
    var banner = document.getElementById("checkout-readiness");
    if (!banner) return;
    apiRequest("/api/health", { retries: 0 }).then(function (resp) {
      if (!resp.ok || !resp.data) {
        banner.style.display = "none";
        return;
      }
      var p = healthInnerPayload(resp);
      if (p.checkoutReady) {
        banner.style.display = "none";
        banner.textContent = "";
        return;
      }
      var lines = [];
      if (Array.isArray(p.checkoutBlockers) && p.checkoutBlockers.length) {
        lines = p.checkoutBlockers.slice();
      } else {
        if (p.stripeSecretKeyOk === false && p.stripeHint) lines.push(p.stripeHint);
        if (p.stripeApiReachable === false) {
          lines.push(
            p.stripeApiError ||
              "Stripe afviser STRIPE_SECRET_KEY. Åbn https://dashboard.stripe.com/test/apikeys — kopier hele Secret key (starter med sk_test_) ind i .env og genstart serveren."
          );
        }
        if (p.checkoutDraftsReachable === false) {
          lines.push("Supabase: tabellen checkout_drafts findes ikke. Kør migrations fra projektets supabase/-mappe.");
        }
        if (!p.stripeWebhookSecretSet && lines.length === 0) {
          lines.push(
            "Valgfrit: STRIPE_WEBHOOK_SECRET til webhooks. Uden den kan ordren stadig oprettes via betalingssiden (success), hvis /api/checkout/complete kører."
          );
        }
      }
      if (!lines.length) {
        lines.push("Checkout er ikke klar. Åbn /api/health i browseren for detaljer.");
      }
      banner.textContent = "Opsætning:\n\n• " + lines.join("\n\n• ");
      banner.style.display = "block";
    });
  }

  function checkoutErrorText(resp) {
    var j = resp.data || {};
    if (typeof j.error === "string" && j.error.length) return j.error;
    if (j.error && typeof j.error === "object" && j.error.message) return String(j.error.message);
    if (j.message) return String(j.message);
    if (resp.message && resp.message !== "Request failed") return resp.message;
    return "Betaling kunne ikke startes. Se den røde boks ovenfor eller åbn /api/health.";
  }

  function ensureShipping(cb) {
    if (shippingMeta) {
      cb();
      return;
    }
    setCheckoutFeedback("Henter leveringslande...", "info");
    apiRequest("/api/shipping", { retries: 1 })
      .then(function (resp) {
        var d = resp.data || null;
        shippingMeta = d && d.ok && d.countries && d.countries.length ? d : SHIPPING_FALLBACK;
        try {
          var s = localStorage.getItem("velden_ship_country");
          if (s && shippingMeta.countries && shippingMeta.countries.some(function (c) { return c.code === s; })) {
            selectedShip = s;
          }
        } catch (e) {}
        if (!resp.ok) {
          setCheckoutFeedback("Kunne ikke hente live fragt. Viser standard lande/priser.", "error");
        } else {
          setCheckoutFeedback("", "info");
        }
        cb();
      })
      .catch(function () {
        shippingMeta = SHIPPING_FALLBACK;
        setCheckoutFeedback("Kunne ikke hente live fragt. Viser standard lande/priser.", "error");
        cb();
      });
  }

  function esc(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function render() {
    var lines = window.VeldenCart ? window.VeldenCart.getCart() : [];
    if (!lines.length) {
      window.location.replace("/cart.html");
      return;
    }

    ensureShipping(function () {
      var sub = 0;
      var orderLines = lines
        .map(function (line) {
          var lineTotal = (line.price || 0) * (line.quantity || 1);
          sub += lineTotal;
          var meta = [line.color, line.size].filter(Boolean).join(" · ");
          return (
            '<div class="checkout-order-line">' +
            '<div class="checkout-order-line__img"><img src="' +
            esc(line.image || "") +
            '" alt="" width="64" height="86" /></div>' +
            '<div><div class="checkout-order-line__name">' +
            esc(line.name || "") +
            "</div>" +
            (meta ? '<div class="checkout-order-line__meta">' + esc(meta) + "</div>" : "") +
            '<div class="checkout-order-line__qty">Antal ' +
            (line.quantity || 1) +
            "</div></div>" +
            '<div class="checkout-order-line__price">' +
            fmt(lineTotal) +
            "</div></div>"
          );
        })
        .join("");

      var shipOpts = "";
      if (shippingMeta && shippingMeta.countries && shippingMeta.countries.length) {
        shipOpts =
          '<div class="checkout-field checkout-field--full">' +
          '<label class="field-label" for="ship-country">Land (forsendelse) *</label>' +
          '<select id="ship-country" class="checkout-country-select" required>' +
          shippingMeta.countries
            .map(function (c) {
              return (
                "<option value='" +
                esc(c.code) +
                "'" +
                (c.code === selectedShip ? " selected" : "") +
                ">" +
                esc(c.name) +
                " — " +
                fmt(c.amountMajor) +
                "</option>"
              );
            })
            .join("") +
          "</select></div>";
      }

      var shipCost = shipAmountFor(selectedShip);
      var total = sub + shipCost;

      root.innerHTML =
        '<a href="/cart.html" class="checkout-back">← Tilbage til kurven</a>' +
        '<p class="checkout-steps"><span class="checkout-steps__done">1 · Kurv</span><span aria-hidden="true"> · </span><span class="checkout-steps__current">2 · Levering</span><span aria-hidden="true"> · </span><span class="checkout-steps__next">3 · Betaling</span></p>' +
        '<h1 class="checkout-page-title">Checkout</h1>' +
        '<div class="checkout-grid">' +
        '<div class="checkout-col checkout-col--summary">' +
        '<div class="checkout-panel">' +
        '<h2 class="checkout-section-title">Din ordre</h2>' +
        '<div class="checkout-order-lines">' +
        orderLines +
        "</div>" +
        '<div class="checkout-totals">' +
        '<div class="checkout-totals__row"><span>Subtotal</span><span>' +
        fmt(sub) +
        "</span></div>" +
        '<div class="checkout-totals__row"><span>Fragt</span><span id="checkout-ship-amount">' +
        (shipOpts ? fmt(shipCost) : "—") +
        "</span></div>" +
        '<div class="checkout-totals__total"><span>At betale</span><span id="checkout-total-amount">' +
        fmt(total) +
        "</span></div></div></div></div>" +
        '<div class="checkout-col checkout-col--form">' +
        '<div class="checkout-panel checkout-panel--form">' +
        '<h2 class="checkout-section-title">Levering</h2>' +
        '<div id="checkout-readiness" class="checkout-readiness" style="display:none" role="alert" aria-live="polite"></div>' +
        '<form id="cx-form" class="checkout-form" novalidate>' +
        '<div class="checkout-form-grid">' +
        '<div class="checkout-field">' +
        '<label class="field-label" for="cx-name">Fulde navn *</label>' +
        '<input id="cx-name" class="checkout-input" required type="text" autocomplete="name" /></div>' +
        '<div class="checkout-field">' +
        '<label class="field-label" for="cx-email">E-mail *</label>' +
        '<input id="cx-email" class="checkout-input" required type="email" autocomplete="email" /></div>' +
        '<div class="checkout-field">' +
        '<label class="field-label" for="cx-phone">Telefon *</label>' +
        '<input id="cx-phone" class="checkout-input" required type="tel" autocomplete="tel" /></div>' +
        '<div class="checkout-field checkout-field--full">' +
        '<label class="field-label" for="cx-address">Adresse (vej og nr.) *</label>' +
        '<input id="cx-address" class="checkout-input" required type="text" autocomplete="street-address" /></div>' +
        '<div class="checkout-field">' +
        '<label class="field-label" for="cx-postal">Postnr. *</label>' +
        '<input id="cx-postal" class="checkout-input" required type="text" autocomplete="postal-code" /></div>' +
        '<div class="checkout-field">' +
        '<label class="field-label" for="cx-city">By *</label>' +
        '<input id="cx-city" class="checkout-input" required type="text" autocomplete="address-level2" /></div>' +
        shipOpts +
        "</div>" +
        '<p id="checkout-feedback" class="checkout-form-note" style="display:none"></p>' +
        '<p class="checkout-form-note checkout-form-note--muted">Land skal matche leveringsadressen. Du sendes videre til Stripe for at gennemføre betalingen.</p>' +
        '<button type="submit" class="btn btn--primary btn--block checkout-pay-btn" id="checkout-pay">Fortsæt til sikker betaling</button>' +
        "</form></div></div></div>";

      var sc = document.getElementById("ship-country");
      if (sc) {
        sc.addEventListener("change", function () {
          selectedShip = sc.value;
          try {
            localStorage.setItem("velden_ship_country", selectedShip);
          } catch (e) {}
          var shipAmountEl = document.getElementById("checkout-ship-amount");
          var totalAmountEl = document.getElementById("checkout-total-amount");
          if (shipAmountEl) shipAmountEl.textContent = fmt(shipAmountFor(selectedShip));
          if (totalAmountEl) totalAmountEl.textContent = fmt(sub + shipAmountFor(selectedShip));
        });
      }

      document.getElementById("cx-form").addEventListener("submit", function (ev) {
        ev.preventDefault();
        var form = document.getElementById("cx-form");
        if (!form.checkValidity()) {
          form.reportValidity();
          return;
        }
        var btn = document.getElementById("checkout-pay");
        var nameEl = document.getElementById("cx-name");
        var emailEl = document.getElementById("cx-email");
        var phoneEl = document.getElementById("cx-phone");
        var addrEl = document.getElementById("cx-address");
        var postEl = document.getElementById("cx-postal");
        var cityEl = document.getElementById("cx-city");
        if (!nameEl || !emailEl || !phoneEl || !addrEl || !postEl || !cityEl) return;
        btn.disabled = true;
        var items = window.VeldenCart.getCart().map(function (l) {
          return {
            productId: l.productId,
            quantity: l.quantity || 1,
            size: l.size || "",
            color: l.color || "",
          };
        });
        var customer = {
          fullName: nameEl.value.trim(),
          email: emailEl.value.trim(),
          phone: phoneEl.value.trim(),
          addressLine1: addrEl.value.trim(),
          postalCode: postEl.value.trim(),
          city: cityEl.value.trim(),
        };
        setCheckoutFeedback("Sender dig videre til sikker betaling...", "info");
        apiRequest("/api/checkout/cart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          retries: 1,
          body: JSON.stringify({ items: items, shippingCountry: selectedShip, customer: customer }),
        })
          .then(function (resp) {
            var j = resp.data || {};
            if (j.url) {
              window.location.href = j.url;
            } else {
              setCheckoutFeedback(checkoutErrorText(resp), "error");
              refreshCheckoutReadiness();
              btn.disabled = false;
            }
          })
          .catch(function () {
            setCheckoutFeedback("Netværksfejl. Prøv igen.", "error");
            btn.disabled = false;
          });
      });
      refreshCheckoutReadiness();
    });
  }

  render();
  window.addEventListener("velden-cart", function () {
    if (!window.VeldenCart.getCart().length) {
      window.location.replace("/cart.html");
      return;
    }
    render();
  });
})();
