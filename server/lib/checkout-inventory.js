/**
 * Pay-time inventory checks before process_checkout_session_atomic.
 * Mirrors rules used when creating Stripe sessions (single + cart).
 */

function parseSupplierVariants(product) {
  if (!product) return [];
  const raw = product.supplier_variants;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }
  return [];
}

function findSelectedVariant(variants, size, color) {
  const s = size != null ? String(size).trim() : "";
  const c = color != null ? String(color).trim() : "";
  if (!variants.length) return null;
  return variants.find((v) => {
    const vs = String((v && v.size) || "").trim();
    const vc = String((v && v.color) || "").trim();
    const sizeOk = !s || !vs || vs === s;
    const colorOk = !c || !vc || vc.toLowerCase() === c.toLowerCase();
    return sizeOk && colorOk;
  });
}

/**
 * @returns {{ ok: true } | { ok: false, reason: "out_of_stock_at_payment" }}
 */
function validateProductRowForCheckout(product) {
  if (!product) {
    return { ok: false, reason: "out_of_stock_at_payment" };
  }
  if (product.status === "removed" || product.status === "inactive") {
    return { ok: false, reason: "out_of_stock_at_payment" };
  }
  if (product.available === false) {
    return { ok: false, reason: "out_of_stock_at_payment" };
  }
  if (product.sourcing_status && product.sourcing_status !== "approved") {
    return { ok: false, reason: "out_of_stock_at_payment" };
  }
  return { ok: true };
}

/**
 * @returns {{ ok: true } | { ok: false, reason: "out_of_stock_at_payment" }}
 */
function validateLineAgainstProduct(product, line) {
  const base = validateProductRowForCheckout(product);
  if (!base.ok) return base;

  const variants = parseSupplierVariants(product);
  if (!variants.length) {
    return { ok: true };
  }

  const size = line && line.size != null ? line.size : "";
  const color = line && line.color != null ? line.color : "";
  const selected = findSelectedVariant(variants, size, color);
  if (selected && selected.available === false) {
    return { ok: false, reason: "out_of_stock_at_payment" };
  }
  return { ok: true };
}

/** @param {object} supabase */
async function verifyCartLinesInventory(supabase, lines) {
  if (!supabase || !Array.isArray(lines) || !lines.length) {
    return { ok: false, reason: "out_of_stock_at_payment" };
  }
  const ids = [...new Set(lines.map((l) => String(l && l.product_id || "").trim()).filter(Boolean))];
  if (!ids.length) {
    return { ok: false, reason: "out_of_stock_at_payment" };
  }
  const { data: products, error } = await supabase.from("products").select("*").in("id", ids);
  if (error || !Array.isArray(products)) {
    return { ok: false, reason: "out_of_stock_at_payment" };
  }
  const byId = Object.fromEntries(products.map((p) => [String(p.id), p]));
  for (const line of lines) {
    const pid = String(line && line.product_id || "").trim();
    if (!pid) continue;
    const p = byId[pid];
    const v = validateLineAgainstProduct(p, line);
    if (!v.ok) return v;
  }
  return { ok: true };
}

/** @param {object} supabase */
async function verifySingleProductInventory(supabase, productId, variantHints = {}) {
  const id = String(productId || "").trim();
  if (!id) {
    return { ok: false, reason: "out_of_stock_at_payment" };
  }
  const { data: product, error } = await supabase.from("products").select("*").eq("id", id).maybeSingle();
  if (error || !product) {
    return { ok: false, reason: "out_of_stock_at_payment" };
  }
  const line = {
    product_id: id,
    size: variantHints.size != null ? String(variantHints.size) : "",
    color: variantHints.color != null ? String(variantHints.color) : "",
  };
  return validateLineAgainstProduct(product, line);
}

module.exports = {
  parseSupplierVariants,
  findSelectedVariant,
  validateProductRowForCheckout,
  validateLineAgainstProduct,
  verifyCartLinesInventory,
  verifySingleProductInventory,
};
