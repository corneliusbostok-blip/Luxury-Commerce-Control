const { createClient } = require("@supabase/supabase-js");

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Approved for storefront, or legacy rows before sourcing_status existed */
function visibleOnShopfront(query) {
  return query.or("sourcing_status.eq.approved,sourcing_status.is.null").neq("status", "inactive");
}

module.exports = { getSupabase, visibleOnShopfront };
