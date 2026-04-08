/**
 * Indlæs .env først, derefter .env.example for nøgler der stadig mangler (override: false).
 * Så kan du have fx ADMIN_SECRET kun i .env.example som skabelon — men **rigtige hemmeligheder hører i .env** (som ikke committes).
 */
const path = require("path");
const dotenv = require("dotenv");

const root = path.join(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.example"), override: false });

module.exports = { root };
