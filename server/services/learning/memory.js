let runtimeMemory = {
  winning_keywords: [],
  losing_keywords: [],
  winning_categories: [],
  losing_categories: [],
};

function unique(arr, limit = 20) {
  return [...new Set((arr || []).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))].slice(0, limit);
}

function normalizeMemory(input) {
  const m = input && typeof input === "object" ? input : {};
  return {
    winning_keywords: unique(m.winning_keywords, 20),
    losing_keywords: unique(m.losing_keywords, 20),
    winning_categories: unique(m.winning_categories, 12),
    losing_categories: unique(m.losing_categories, 12),
  };
}

function getLearningMemory(storeConfig = null) {
  const fromCfg =
    storeConfig && storeConfig.learning_memory && typeof storeConfig.learning_memory === "object"
      ? normalizeMemory(storeConfig.learning_memory)
      : null;
  return fromCfg || runtimeMemory;
}

function mergeSignals(oldArr, newArr, keep = 16) {
  const oldNorm = unique(oldArr, keep * 2);
  const newNorm = unique(newArr, keep * 2);
  const merged = [...newNorm, ...oldNorm.filter((x) => !newNorm.includes(x))];
  return merged.slice(0, keep);
}

function updateLearningMemory(current, incoming) {
  const cur = normalizeMemory(current);
  const inc = normalizeMemory(incoming);
  runtimeMemory = {
    winning_keywords: mergeSignals(cur.winning_keywords, inc.winning_keywords, 16),
    losing_keywords: mergeSignals(cur.losing_keywords, inc.losing_keywords, 16),
    winning_categories: mergeSignals(cur.winning_categories, inc.winning_categories, 10),
    losing_categories: mergeSignals(cur.losing_categories, inc.losing_categories, 10),
  };
  return runtimeMemory;
}

module.exports = {
  getLearningMemory,
  updateLearningMemory,
  normalizeMemory,
};
