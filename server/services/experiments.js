function assignVariant(product) {
  const p = product || {};
  const key = String(p.id || p.external_id || p.name || "v");
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % 2 === 0 ? "A" : "B";
}

function trackVariantPerformance(product) {
  const p = product || {};
  return {
    variant: p.experiment_variant || null,
    orders: Number(p.orders_count) || 0,
    revenue: (Number(p.orders_count) || 0) * (Number(p.price) || 0),
  };
}

module.exports = {
  assignVariant,
  trackVariantPerformance,
};
