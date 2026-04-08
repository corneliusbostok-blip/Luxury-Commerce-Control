const serverless = require("serverless-http");

const { app, initializeVeldenServerless } = require("../../server/index");

initializeVeldenServerless({ forceServerless: true });

/**
 * Exposes the existing Express app as a Netlify Function.
 *
 * With redirects in netlify.toml:
 *   /api/* -> /.netlify/functions/api/api/:splat
 *
 * ...the Express app continues to receive paths starting with /api/...
 */
module.exports.handler = serverless(app);

