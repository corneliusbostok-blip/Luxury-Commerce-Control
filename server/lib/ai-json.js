function stripJsonFence(text) {
  if (!text) return "{}";
  let t = String(text).trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/s, "");
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}

module.exports = {
  stripJsonFence,
};
