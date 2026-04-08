/**
 * Detect serverless hosts so we do not assume background timers or in-process workers.
 */

function detectServerlessRuntime() {
  const explicit = String(process.env.VELDEN_RUN_MODE || "").trim().toLowerCase();
  if (explicit === "serverless") return true;
  if (explicit === "server") return false;
  if (String(process.env.NETLIFY || "").toLowerCase() === "true") return true;
  if (String(process.env.AWS_LAMBDA_FUNCTION_NAME || "").trim()) return true;
  if (String(process.env.VERCEL || "").trim()) return true;
  return false;
}

module.exports = { detectServerlessRuntime };
