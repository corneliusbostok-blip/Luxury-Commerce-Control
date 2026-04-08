const LOCK_TTL_MS = Math.max(30_000, Number(process.env.AUTOMATION_LOCK_TTL_MS) || 8 * 60 * 1000);

/** Only for local/dev. Never enable in production — marketing dedupe requires atomic DB lock. */
const ALLOW_NON_ATOMIC_LOCK_FALLBACK = /^1|true|yes$/i.test(String(process.env.ALLOW_NON_ATOMIC_LOCKS || ""));

class AtomicLockRpcError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "AtomicLockRpcError";
    this.code = "ATOMIC_LOCK_RPC_REQUIRED";
    if (cause) this.cause = cause;
  }
}

function expiryIso(ttlMs) {
  return new Date(Date.now() + ttlMs).toISOString();
}

async function acquireLock(supabase, key, ttlMs = LOCK_TTL_MS) {
  if (!supabase || !key) return false;
  const { data: row } = await supabase
    .from("automation_locks")
    .select("key, expires_at")
    .eq("key", key)
    .maybeSingle();
  const now = Date.now();
  const exp = row && row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (exp > now) return false;

  const { error } = await supabase
    .from("automation_locks")
    .upsert({ key, expires_at: expiryIso(ttlMs) }, { onConflict: "key" });
  return !error;
}

async function releaseLock(supabase, key) {
  if (!supabase || !key) return;
  await supabase.from("automation_locks").delete().eq("key", key);
}

/**
 * Atomic cross-process lock via acquire_automation_lock RPC (migrate_automation_lock_atomic_acquire.sql).
 * Production: throws AtomicLockRpcError if RPC is missing or errors — NO silent fallback.
 * Optional dev escape: ALLOW_NON_ATOMIC_LOCKS=1 restores legacy acquireLock (unsafe across processes).
 */
async function acquireLockAtomic(supabase, key, ttlMs = LOCK_TTL_MS) {
  if (!supabase || !key) {
    throw new AtomicLockRpcError("acquireLockAtomic: supabase and key are required");
  }
  const ms = Math.max(1000, Math.floor(Number(ttlMs) || LOCK_TTL_MS));
  try {
    const { data, error } = await supabase.rpc("acquire_automation_lock", { p_key: key, p_ttl_ms: ms });
    if (error) {
      if (ALLOW_NON_ATOMIC_LOCK_FALLBACK) {
        console.error(
          "[automation-lock] ALLOW_NON_ATOMIC_LOCKS active — using unsafe fallback. Remove in production.",
          error.message || String(error)
        );
        return acquireLock(supabase, key, ttlMs);
      }
      throw new AtomicLockRpcError(
        `acquire_automation_lock RPC failed: ${error.message || error.code || "unknown"}. Apply supabase/migrate_automation_lock_atomic_acquire.sql.`,
        error
      );
    }
    if (data === null || data === undefined) {
      if (ALLOW_NON_ATOMIC_LOCK_FALLBACK) {
        console.error("[automation-lock] RPC returned null — unsafe fallback (ALLOW_NON_ATOMIC_LOCKS).");
        return acquireLock(supabase, key, ttlMs);
      }
      throw new AtomicLockRpcError(
        "acquire_automation_lock returned no data — migration missing or RPC not deployed."
      );
    }
    return Boolean(data);
  } catch (e) {
    if (e instanceof AtomicLockRpcError) throw e;
    if (ALLOW_NON_ATOMIC_LOCK_FALLBACK) {
      console.error("[automation-lock] RPC threw — unsafe fallback (ALLOW_NON_ATOMIC_LOCKS).", e && e.message);
      return acquireLock(supabase, key, ttlMs);
    }
    throw new AtomicLockRpcError(
      `acquire_automation_lock unavailable: ${e && e.message ? e.message : String(e)}. Apply supabase/migrate_automation_lock_atomic_acquire.sql.`,
      e
    );
  }
}

module.exports = {
  acquireLock,
  acquireLockAtomic,
  releaseLock,
  AtomicLockRpcError,
  ALLOW_NON_ATOMIC_LOCK_FALLBACK,
};
