(function () {
  function el(id) {
    return document.getElementById(id);
  }
  function setNotice(text, ok) {
    var n = el("mk-notice");
    if (!n) return;
    n.textContent = text || "";
    n.classList.remove("ok", "err");
    if (!text) return;
    n.classList.add(ok ? "ok" : "err");
  }

  function apiFailureMessage(data, res) {
    if (data && typeof data.message === "string" && data.message.trim()) return data.message.trim();
    if (data && typeof data.error === "string" && data.error.trim()) return data.error.trim();
    if (data && data.error && typeof data.error === "object" && data.error.code) {
      return String(data.error.code);
    }
    if (res.status === 401) {
      return "Ikke logget ind — åbn /admin-login.html og indtast samme kode som ADMIN_SECRET (Netlify miljøvariabel).";
    }
    return "Request failed";
  }

  function errMessage(e) {
    if (e == null) return "ukendt fejl";
    if (typeof e === "string") return e;
    if (e instanceof Error && e.message) return e.message;
    if (typeof e === "object" && e.message != null) return String(e.message);
    try {
      return JSON.stringify(e);
    } catch (_) {
      return String(e);
    }
  }

  function readStoredAdminSecret() {
    try {
      return String(localStorage.getItem("velden_admin_secret") || "").trim();
    } catch (_) {
      return "";
    }
  }

  async function api(url, options) {
    var U = typeof window !== "undefined" ? window.VeldenUnauthorized : null;
    var opts = Object.assign({ credentials: "include", cache: "no-store" }, options || {});
    var headers = Object.assign({}, opts.headers || {});
    var sec = readStoredAdminSecret();
    if (sec) headers["X-Admin-Secret"] = sec;
    opts.headers = headers;
    const res = await fetch(url, opts);
    const data = await res.json().catch(function () {
      return null;
    });
    if (res.status === 401 && U) {
      U.report(apiFailureMessage(data, res));
    } else if (res.ok && U) {
      U.noteResponseOk(true);
    }
    if (!res.ok || !data || data.ok === false) {
      throw new Error(apiFailureMessage(data, res));
    }
    return data;
  }

  function renderPlatforms(platforms) {
    const box = el("platform-grid");
    box.innerHTML = "";
    var rows = Array.isArray(platforms) && platforms.length
      ? platforms
      : [{ platform: "facebook", connected: false, enabled: false }, { platform: "instagram", connected: false, enabled: false }, { platform: "tiktok", connected: false, enabled: false }];
    rows.forEach(function (p) {
      const card = document.createElement("div");
      card.className = "adm-panel";
      const statusClass = p.connected ? "ok" : "bad";
      card.style.padding = "0.8rem";
      const method = String(p.authMethod || "").toLowerCase();
      const connectedAt = p.connectedAt ? new Date(p.connectedAt).toLocaleString("da-DK") : "";
      const badge = p.connected
        ? method === "oauth"
          ? "OAuth connected via login"
          : "Connected"
        : "Not connected";
      card.innerHTML =
        "<h3>" +
        p.platform[0].toUpperCase() +
        p.platform.slice(1) +
        "</h3>" +
        '<div class="status ' +
        statusClass +
        '">' +
        (p.connected ? "Connected ✅" : "Not connected ❌") +
        "</div>" +
        '<div class="hint-muted" style="font-size:.82rem; margin-top:.25rem;">' +
        badge +
        (connectedAt ? " · " + connectedAt : "") +
        "</div>" +
        '<div class="row">' +
        '<button data-connect="' +
        p.platform +
        '">' +
        (p.connected ? "Reconnect login" : "Login & Connect") +
        "</button>" +
        '<button data-disconnect="' +
        p.platform +
        '">' +
        "Disconnect" +
        "</button>" +
        '<button data-toggle="' +
        p.platform +
        '" data-enabled="' +
        (p.enabled ? "1" : "0") +
        '">' +
        (p.enabled ? "Disable" : "Enable") +
        "</button>" +
        '<button class="primary" data-post-now="' +
        p.platform +
        '">' +
        "Post now" +
        "</button>" +
        "</div>";
      box.appendChild(card);

      var btnConnect = card.querySelector("[data-connect]");
      if (btnConnect) {
        btnConnect.addEventListener("click", function (ev) {
          ev.preventDefault();
          connect(p.platform);
        });
      }
      var btnDisconnect = card.querySelector("[data-disconnect]");
      if (btnDisconnect) {
        btnDisconnect.addEventListener("click", function (ev) {
          ev.preventDefault();
          disconnect(p.platform);
        });
      }
      var btnToggle = card.querySelector("[data-toggle]");
      if (btnToggle) {
        btnToggle.addEventListener("click", function (ev) {
          ev.preventDefault();
          toggle(p.platform, p.enabled === true);
        });
      }
      var btnPostNow = card.querySelector("[data-post-now]");
      if (btnPostNow) {
        btnPostNow.addEventListener("click", function (ev) {
          ev.preventDefault();
          postNow(p.platform);
        });
      }
    });
  }

  function renderPosts(posts) {
    const box = el("posts-list");
    box.innerHTML = "";
    (posts || []).forEach(function (p) {
      const item = document.createElement("div");
      item.className = "adm-panel";
      item.style.padding = "0.65rem";
      item.style.marginBottom = "0.55rem";
      const head = document.createElement("div");
      head.innerHTML =
        "<strong>" +
        (p.platform || "unknown") +
        "</strong> · <span class='meta'>" +
        (p.status || "unknown") +
        " · " +
        new Date(p.created_at || Date.now()).toLocaleString("da-DK") +
        "</span>";
      item.appendChild(head);
      const cap = document.createElement("div");
      cap.style.marginTop = "0.4rem";
      cap.textContent = p.caption || "";
      item.appendChild(cap);
      if (p.error_class) {
        const ec = document.createElement("div");
        ec.className = "meta";
        ec.style.marginTop = "0.35rem";
        ec.textContent = "Årsag: " + p.error_class;
        item.appendChild(ec);
      }
      if (p.error) {
        const er = document.createElement("div");
        er.className = "hint-muted";
        er.style.marginTop = "0.25rem";
        er.style.color = "#b44";
        er.textContent = p.error;
        item.appendChild(er);
      }
      box.appendChild(item);
    });
    if (!posts || !posts.length) box.innerHTML = "<div class='hint-muted'>No posts yet.</div>";
  }

  function setSettings(data) {
    el("mk-enabled").checked = Boolean(data.enabled);
    el("mk-new-product").checked = Boolean(data.settings && data.settings.postOnNewProduct);
    el("mk-price-drop").checked = Boolean(data.settings && data.settings.postOnPriceDrop);
    el("mk-trending").checked = Boolean(data.settings && data.settings.postOnTrendingProduct);
    const max = Number((data.settings && data.settings.maxPostsPerDay) || 3);
    el("mk-max-posts").value = String(max);
    el("mk-max-label").textContent = String(max);
  }

  async function loadStatus() {
    const data = await api("/api/admin/marketing/status");
    renderPlatforms(data.platforms || []);
    setSettings(data);
    setNotice("Platform status loaded.", true);
  }

  async function loadPosts() {
    const data = await api("/api/admin/marketing/posts");
    renderPosts(data.posts || []);
  }

  async function loadPostProducts() {
    const data = await api("/api/admin/marketing/post-products");
    const select = el("manual-product");
    if (!select) return;
    const existing = select.value;
    select.innerHTML = '<option value="">Auto (best product)</option>';
    (data.products || []).forEach(function (p) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name + " · " + p.category + " · " + p.price + " kr";
      select.appendChild(opt);
    });
    if (existing) select.value = existing;
  }

  async function connect(platform) {
    try {
      setNotice("Starter login for " + platform + "…", true);
      // Fetch provider URL through authenticated API call (keeps admin auth header/cookie flow).
      const out = await api("/api/admin/marketing/oauth/" + encodeURIComponent(platform) + "/authorize-url");
      if (!out || !out.url) throw new Error("OAuth URL mangler");
      window.location.assign(out.url);
    } catch (err) {
      setNotice((err && err.message) || "Kunne ikke starte login. Tjek admin login.", false);
    }
  }

  async function toggle(platform, enabled) {
    await api("/api/admin/marketing/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: platform, enabled: !enabled }),
    });
    await loadStatus();
  }

  async function disconnect(platform) {
    await api("/api/admin/marketing/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: platform }),
    });
    setNotice("Disconnected " + platform + ".", true);
    await loadStatus();
  }

  async function saveSettings() {
    await api("/api/admin/marketing/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: el("mk-enabled").checked,
        postOnNewProduct: el("mk-new-product").checked,
        postOnPriceDrop: el("mk-price-drop").checked,
        postOnTrendingProduct: el("mk-trending").checked,
        maxPostsPerDay: Number(el("mk-max-posts").value || 3),
      }),
    });
    await loadStatus();
  }

  async function testPost() {
    const platform = el("test-platform").value;
    const productId = (el("manual-product") && el("manual-product").value) || "";
    const data = await api("/api/admin/marketing/test-post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: platform, productId: productId || undefined, title: "AI Test Product", category: "outerwear", price: 399 }),
    });
    const preview = data.content || {};
    el("preview-image").src =
      preview.image ||
      "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=800&q=80";
    el("preview-caption").textContent = preview.caption || "No caption generated.";
    el("preview-tags").textContent = Array.isArray(preview.hashtags) ? preview.hashtags.join(" ") : "";
    var link = el("preview-link");
    if (link) {
      link.href = preview.url || "#";
      link.textContent = preview.url ? "Open product page" : "No product link";
    }
    await loadPosts();
  }

  async function postNow(platform) {
    try {
      setNotice("Sender post…", true);
      var productId = (el("manual-product") && el("manual-product").value) || "";
      var body = { platform: platform };
      if (productId) body.productId = productId;
      const data = await api("/api/admin/marketing/post-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const preview = data.content || {};
      el("preview-image").src =
        preview.image ||
        "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=800&q=80";
      el("preview-caption").textContent = preview.caption || "Posted.";
      el("preview-tags").textContent = Array.isArray(preview.hashtags) ? preview.hashtags.join(" ") : "";
      var link = el("preview-link");
      if (link) {
        link.href = preview.url || "#";
        link.textContent = preview.url ? "Open product page" : "No product link";
      }
      await loadPosts();
      setNotice("Post sendt til " + platform + ".", true);
    } catch (e) {
      setNotice("Kunne ikke poste til " + platform + ": " + errMessage(e), false);
    }
  }

  // Button handlers are bound directly in renderPlatforms for robustness.

  el("mk-max-posts").addEventListener("input", function () {
    el("mk-max-label").textContent = String(el("mk-max-posts").value);
  });
  el("save-settings").addEventListener("click", saveSettings);
  el("generate-test").addEventListener("click", testPost);

  Promise.all([loadStatus(), loadPosts(), loadPostProducts()]).catch(function (e) {
    window.alert("Kunne ikke indlæse marketing side: " + errMessage(e));
  });

  (function handleOauthResult() {
    try {
      var u = new URL(window.location.href);
      var oauth = u.searchParams.get("oauth");
      var platform = u.searchParams.get("platform");
      var reason = u.searchParams.get("reason");
      if (oauth === "ok") {
        setNotice("Connected via login: " + (platform || "platform") + " ✅", true);
      } else if (oauth === "error") {
        setNotice("OAuth fejl: " + (reason || "ukendt"), false);
      }
      if (oauth) {
        u.searchParams.delete("oauth");
        u.searchParams.delete("platform");
        u.searchParams.delete("reason");
        window.history.replaceState({}, "", u.pathname + (u.search ? u.search : ""));
      }
    } catch (_) {
      // ignore
    }
  })();
})();
