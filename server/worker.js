const { createClient } = require("@supabase/supabase-js");
const { startShopEventConsumers } = require("./services/shop-service/event-consumers");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

console.log("🚀 Worker started");

setInterval(() => {
  console.log("✅ Worker alive:", new Date().toISOString());
}, 10000);

startShopEventConsumers(() => supabase);
