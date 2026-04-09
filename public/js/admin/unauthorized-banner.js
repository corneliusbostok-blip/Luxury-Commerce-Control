/**
 * Shared admin 401 / unauthorized UI (err-banner on dashboard, mk-auth-banner on standalone marketing).
 * Loaded before admin app / marketing scripts.
 */
(function (global) {
  var authExpired = false;

  function resolveBannerEl() {
    return (
      document.getElementById("err-banner") ||
      document.getElementById("adm-auth-banner") ||
      document.getElementById("mk-auth-banner")
    );
  }

  function defaultMessage() {
    return "Log ind igen: åbn /admin-login.html og indtast din admin-kode.";
  }

  /** Serverens standard-401-tekst — vis dansk + link i stedet for lang engelsk sætning. */
  function fillUnauthorizedBanner(panelErr, rawMessage) {
    var s = String(rawMessage || "").trim();
    if (/Unauthorized\. Send X-Admin-Secret/i.test(s)) {
      panelErr.textContent = "";
      var strong = document.createElement("strong");
      strong.textContent = "Du er ikke logget ind (eller forkert kode). ";
      panelErr.appendChild(strong);
      var a = document.createElement("a");
      a.href = "/admin-login.html?next=" + encodeURIComponent(location.pathname + location.search + location.hash);
      a.textContent = "Gå til login";
      panelErr.appendChild(a);
      panelErr.appendChild(
        document.createTextNode(" — brug præcis samme kode som ADMIN_SECRET i Netlify.")
      );
      return;
    }
    panelErr.textContent = s || defaultMessage();
  }

  global.VeldenUnauthorized = {
    report: function (message) {
      authExpired = true;
      var panelErr = resolveBannerEl();
      if (!panelErr) return;
      fillUnauthorizedBanner(panelErr, message);
      panelErr.style.display = "block";
    },

    /** Call after an admin HTTP response; clears the banner when reconnect succeeds (2xx). */
    noteResponseOk: function (httpOk) {
      if (!httpOk || !authExpired) return;
      authExpired = false;
      var panelErr = resolveBannerEl();
      if (panelErr) panelErr.style.display = "none";
    },

    get expired() {
      return authExpired;
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
