const rateLimit = require("express-rate-limit");
const { z } = require("zod");

const globalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_GLOBAL_PER_MIN || 240),
  skip: (req) => req.path === "/api/stripe/webhook",
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests." },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_LOGIN_PER_15MIN || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many login attempts." },
});

const trackingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_TRACKING_PER_MIN || 180),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Tracking rate limit exceeded." },
});

const sourcingChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_SOURCING_CHAT_PER_MIN || 45),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Sourcing chat rate limit exceeded." },
});

const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_CHECKOUT_PER_MIN || 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Checkout rate limit exceeded." },
});

function validateBody(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        status: "error",
        reason: "invalid_body",
        error: "Invalid request body",
        details: parsed.error.issues.map((x) => ({ path: x.path.join("."), message: x.message })),
      });
    }
    req.validatedBody = parsed.data;
    return next();
  };
}

const schemas = {
  adminLogin: z.object({ adminSecret: z.string().min(1) }),
  trackEvent: z.object({ productId: z.string().uuid() }),
  sourcingChat: z.object({
    sessionId: z.string().min(1).max(200).optional(),
    message: z.string().min(1).max(2000),
    candidate: z.unknown().optional(),
  }),
  newsletter: z.object({ email: z.string().email() }),
  checkoutSingle: z.object({
    productId: z.string().uuid(),
    shippingCountry: z.string().min(2).max(2),
    customer: z.object({
      fullName: z.string().min(2),
      email: z.string().email(),
      phone: z.string().min(6),
      addressLine1: z.string().min(4),
      postalCode: z.string().min(2),
      city: z.string().min(2),
    }),
    color: z.string().optional(),
  }),
  checkoutCart: z.object({
    shippingCountry: z.string().min(2).max(2),
    customer: z.object({
      fullName: z.string().min(2),
      email: z.string().email(),
      phone: z.string().min(6),
      addressLine1: z.string().min(4),
      postalCode: z.string().min(2),
      city: z.string().min(2),
    }),
    items: z
      .array(
        z.object({
          productId: z.string().uuid(),
          quantity: z.number().int().min(1).max(10),
          size: z.string().optional(),
          color: z.string().optional(),
        })
      )
      .min(1)
      .max(25),
  }),
  adminBotTts: z.object({ text: z.string().min(1).max(5000) }),
  adminStoreConfig: z
    .object({
      config: z.object({}).passthrough().optional(),
    })
    .passthrough(),
  adminCeoPause: z.object({ paused: z.boolean() }),
  adminPurgeAll: z.object({ confirm: z.literal("SLET_ALLE_PRODUKTER") }),
  adminShopifyImport: z.object({
    shopUrl: z.string().url().optional(),
    url: z.string().url().optional(),
    forceCategory: z.string().optional(),
    collectionHandle: z.string().optional(),
  }).refine((v) => Boolean(v.shopUrl || v.url), { message: "shopUrl or url is required" }),
  adminProductStatusPatch: z.object({ sourcing_status: z.enum(["draft", "approved", "rejected"]) }),
  adminSeoRun: z.object({ productId: z.string().uuid().optional(), id: z.string().uuid().optional() }).refine(
    (v) => Boolean(v.productId || v.id),
    { message: "productId or id is required" }
  ),
  adminSourcingCandidateDecision: z.object({ reason: z.string().max(1000).optional() }),
  adminFillShop: z.object({
    dryRun: z.boolean().optional(),
    maxCycles: z.number().int().min(1).max(25).optional(),
    perCycleLimit: z.number().int().min(10).max(20).optional(),
    cooldownMs: z.number().int().min(1000).max(120000).optional(),
  }),
  adminRunAiCeo: z.object({
    dryRun: z.boolean().optional(),
    mode: z.enum(["light", "full"]).optional(),
  }),
  adminMarketingConnect: z.object({
    platform: z.enum(["facebook", "instagram", "tiktok"]),
    token: z.string().min(1),
    pageId: z.string().max(120).optional(),
    igUserId: z.string().max(120).optional(),
    accountId: z.string().max(120).optional(),
  }),
  adminMarketingToggle: z.object({
    platform: z.enum(["facebook", "instagram", "tiktok"]),
    enabled: z.boolean(),
  }),
  adminMarketingDisconnect: z.object({
    platform: z.enum(["facebook", "instagram", "tiktok"]),
  }),
  adminMarketingSettings: z.object({
    enabled: z.boolean().optional(),
    postOnNewProduct: z.boolean().optional(),
    postOnPriceDrop: z.boolean().optional(),
    postOnTrendingProduct: z.boolean().optional(),
    maxPostsPerDay: z.number().int().min(1).max(20).optional(),
  }),
  adminMarketingTestPost: z.object({
    platform: z.enum(["facebook", "instagram", "tiktok"]).optional(),
    productId: z.string().uuid().optional(),
    title: z.string().min(1).max(200).optional(),
    category: z.string().max(100).optional(),
    price: z.number().positive().optional(),
    image: z.string().url().optional(),
  }),
  adminMarketingPostNow: z.object({
    platform: z.enum(["facebook", "instagram", "tiktok"]),
    productId: z.string().uuid().optional(),
  }),
  adminMarketingBackfillConnections: z.object({
    dryRun: z.boolean().optional(),
    clearLegacyTokens: z.boolean().optional(),
  }),
};

module.exports = {
  globalApiLimiter,
  loginLimiter,
  trackingLimiter,
  sourcingChatLimiter,
  checkoutLimiter,
  validateBody,
  schemas,
};
