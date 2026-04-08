-- Atomic lock acquire for concurrent workers (INSERT after DELETE expired only wins once).
-- REQUIRED for marketing outbound publish: Node must not fall back unless ALLOW_NON_ATOMIC_LOCKS=1 (dev only).

create or replace function acquire_automation_lock(p_key text, p_ttl_ms int)
returns boolean
language plpgsql
as $$
declare
  inserted int;
  ttl interval;
  ms int;
begin
  if p_key is null or length(trim(p_key)) = 0 then
    return false;
  end if;
  ms := greatest(1000, coalesce(p_ttl_ms, 480000));
  ttl := (ms::text || ' milliseconds')::interval;
  delete from automation_locks where key = p_key and expires_at < now();
  insert into automation_locks (key, expires_at)
  values (p_key, now() + ttl)
  on conflict (key) do nothing;
  get diagnostics inserted = row_count;
  if inserted > 0 then
    return true;
  end if;
  return false;
end;
$$;
