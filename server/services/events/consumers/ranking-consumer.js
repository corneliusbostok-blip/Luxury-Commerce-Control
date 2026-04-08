const { computeProductRankScore, resolveRankAction } = require("../../ranking/engine");

function daysBetweenIso(a, b) {
  const aa = Date.parse(a || 0);
  const bb = Date.parse(b || 0);
  if (!aa || !bb) return 0;
  return Math.max(0, (bb - aa) / 86400000);
}

async function applyLiveRankingUpdate(supabase, productId) {
  if (!supabase || !productId) return;
  const { data: p, error } = await supabase
    .from("products")
    .select("*")
    .eq("id", productId)
    .maybeSingle();
  if (error || !p) return;

  const nowIso = new Date().toISOString();
  const { score } = computeProductRankScore({
    views: Number(p.views) || 0,
    clicks: Number(p.clicks) || 0,
    add_to_cart: Number(p.add_to_cart_count) || 0,
    orders: Number(p.orders_count) || 0,
    revenue: (Number(p.orders_count) || 0) * (Number(p.price) || 0),
    profit:
      (Number(p.orders_count) || 0) *
      Math.max(
        0,
        (Number(p.unit_profit) || 0) ||
          ((Number(p.price) || 0) - (Number(p.cost) || 0) - (Number(p.estimated_shipping_cost) || 0))
      ),
    unit_profit:
      Number(p.unit_profit) ||
      Math.max(0, (Number(p.price) || 0) - (Number(p.cost) || 0) - (Number(p.estimated_shipping_cost) || 0)),
  });
  const minViews = Number(process.env.RANK_MIN_VIEWS) || 50;
  const cooldownHours = Number(process.env.RANK_STATE_COOLDOWN_HOURS) || 24;
  const cooldownDaysForRemove = Number(process.env.RANK_REMOVE_DAYS_LOW) || 7;
  const views = Number(p.views) || 0;
  const lastChangedAt = p.rank_last_changed_at || null;
  const cooldownPassed = !lastChangedAt || (Date.now() - Date.parse(lastChangedAt)) / 3600000 >= cooldownHours;

  let rankLowSince = p.rank_low_since || null;
  if (score < 30 && views >= minViews) {
    rankLowSince = rankLowSince || nowIso;
  } else {
    rankLowSince = null;
  }
  const daysLow = rankLowSince ? daysBetweenIso(rankLowSince, nowIso) : 0;
  const action = resolveRankAction({
    score,
    views,
    daysLow,
    minViews,
    daysBelowRemove: cooldownDaysForRemove,
  });

  let nextState = p.rank_state || "normal";
  let nextStatus = p.status || "active";
  if (cooldownPassed) {
    if (action === "boost") nextState = "boosted";
    else if (action === "deprioritize") nextState = "deprioritized";
    else if (action === "keep") nextState = "normal";
    if (action === "remove") nextStatus = "removed";
  }

  await supabase
    .from("products")
    .update({
      score,
      rank_state: nextState,
      rank_low_since: rankLowSince,
      rank_last_changed_at: cooldownPassed ? nowIso : lastChangedAt,
      status: nextStatus,
      updated_at: nowIso,
    })
    .eq("id", productId);
}

module.exports = { applyLiveRankingUpdate };
