function normalize(v) {
  return String(v || "")
    .toLowerCase()
    .trim();
}

function hashScore(s) {
  let h = 0;
  const x = String(s || "");
  for (let i = 0; i < x.length; i += 1) h = (h * 31 + x.charCodeAt(i)) | 0;
  return Math.abs(h % 100);
}

function momentumFromScore(score) {
  if (score >= 72) return "rising";
  if (score <= 35) return "falling";
  return "stable";
}

function buildTrendSignals({ category, season, vibeKeywords = [] } = {}) {
  const cat = normalize(category).replace(/_/g, " ");
  if (!cat) return [];
  const seasonPart = normalize(season);
  const vibe = (vibeKeywords || []).map((v) => normalize(v)).filter(Boolean).slice(0, 3);
  const base = [
    `${cat} trending 2026`,
    `${cat} best seller`,
    `${cat} rising demand`,
    ...vibe.map((v) => `${v} ${cat}`),
  ];
  if (seasonPart) base.push(`${seasonPart} ${cat}`, `${cat} ${seasonPart} trend`);
  const uniq = [...new Set(base.map((x) => x.trim()).filter(Boolean))];
  return uniq.map((keyword) => {
    const trend_score = Math.max(20, Math.min(100, 45 + hashScore(keyword) * 0.55));
    return {
      keyword,
      trend_score: Number(trend_score.toFixed(2)),
      momentum: momentumFromScore(trend_score),
    };
  });
}

function keywordTrendMap(trends = []) {
  const m = new Map();
  for (const t of trends || []) {
    if (!t || !t.keyword) continue;
    m.set(normalize(t.keyword), t);
  }
  return m;
}

function matchesTrendText(text, trends = []) {
  const t = normalize(text);
  if (!t) return null;
  for (const tr of trends || []) {
    const k = normalize(tr.keyword);
    if (!k) continue;
    const token = k.split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
    if (token && t.includes(token)) return tr;
  }
  return null;
}

module.exports = {
  buildTrendSignals,
  keywordTrendMap,
  matchesTrendText,
};
