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

  global.VeldenUnauthorized = {
    report: function (message) {
      authExpired = true;
      try {
        localStorage.removeItem("velden_admin_secret");
      } catch (_) {}
      var panelErr = resolveBannerEl();
      if (!panelErr) return;
      panelErr.textContent = (message && String(message).trim()) || defaultMessage();
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
