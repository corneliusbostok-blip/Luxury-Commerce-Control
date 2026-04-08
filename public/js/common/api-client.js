(function () {
  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function request(url, options) {
    var opts = options || {};
    var retries = Number.isFinite(opts.retries) ? opts.retries : 1;
    var retryDelayMs = Number.isFinite(opts.retryDelayMs) ? opts.retryDelayMs : 350;
    var attempt = 0;
    var lastErr = null;

    while (attempt <= retries) {
      try {
        var merged = Object.assign({ credentials: "include" }, opts || {});
        var res = await fetch(url, merged);
        var text = await res.text();
        var json = null;
        if (text) {
          try {
            json = JSON.parse(text);
          } catch (_e) {
            json = null;
          }
        }
        var ok =
          !!res.ok &&
          ((json && (json.success === true || json.ok === true)) ||
            (!json && res.status >= 200 && res.status < 300));
        return {
          ok: ok,
          status: res.status,
          response: res,
          data: json,
          message:
            (json && (json.message || json.error)) ||
            (ok ? "OK" : "Request failed"),
        };
      } catch (err) {
        lastErr = err;
        if (attempt >= retries) break;
        await sleep(retryDelayMs * (attempt + 1));
      }
      attempt += 1;
    }

    return {
      ok: false,
      status: 0,
      response: null,
      data: null,
      message: (lastErr && lastErr.message) || "Netvaerksfejl",
      error: lastErr || null,
    };
  }

  window.VeldenApiClient = {
    request: request,
  };
})();
