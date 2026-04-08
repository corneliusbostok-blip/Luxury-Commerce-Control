/**
 * Synkroniser public/data/store-taxonomy.json med server/services/store-taxonomy.js
 * Kør efter ændringer i taxonomi: node scripts/sync-store-taxonomy.js
 */
const fs = require("fs");
const path = require("path");
const t = require("../server/services/store-taxonomy");
const out = {
  verticals: t.STORE_VERTICALS,
  allCategoryIds: t.ALL_MERGED_CATEGORY_IDS,
  labels: t.LABELS_DA,
};
const dir = path.join(__dirname, "..", "public", "data");
fs.mkdirSync(dir, { recursive: true });
const fp = path.join(dir, "store-taxonomy.json");
fs.writeFileSync(fp, JSON.stringify(out), "utf8");
console.log("store-taxonomy.json", fp, fs.statSync(fp).size, "bytes");
