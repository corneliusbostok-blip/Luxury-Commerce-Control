/** @param {string | null | undefined} s */
export function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {{ json?: boolean }} [opts] — set json:false for DELETE/GET with no body (avoids useless Content-Type).
 */
export function readAdminSecret() {
  return "";
}

/**
 * @param {{ json?: boolean }} [opts] — set json:false for DELETE/GET with no body (avoids useless Content-Type).
 */
export function adminHeaders(opts = {}) {
  const json = opts.json !== false;
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  const sec = readAdminSecret();
  if (sec) h["X-Admin-Secret"] = sec;
  return h;
}

export function fmtCatalogPrice(n) {
  const x = Number(n);
  if (n == null || n === "" || Number.isNaN(x)) return "—";
  try {
    return x.toLocaleString("da-DK", {
      style: "currency",
      currency: "DKK",
      maximumFractionDigits: 0,
    });
  } catch {
    return `${Math.round(x)} kr.`;
  }
}

export function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
  } catch {
    return String(iso);
  }
}

export function scoreBand(n) {
  if (n == null || n === "" || Number.isNaN(Number(n))) return { label: "—", short: "" };
  const v = Number(n);
  if (v >= 80) return { label: "Strong fit", short: "strong" };
  if (v >= 55) return { label: "Medium fit", short: "medium" };
  return { label: "Weak fit", short: "weak" };
}

export function estimateNextCycleAt(lastRunIso, intervalHours) {
  if (!lastRunIso || intervalHours == null || Number.isNaN(Number(intervalHours))) return null;
  try {
    return new Date(new Date(lastRunIso).getTime() + Number(intervalHours) * 3600000);
  } catch {
    return null;
  }
}
