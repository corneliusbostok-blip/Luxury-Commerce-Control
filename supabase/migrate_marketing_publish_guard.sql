-- Durable idempotency: one successful outbound marketing post per (ref_key, platform).
-- Survives store_config log loss. Use with acquire_automation_lock + application flow.

create table if not exists marketing_publish_guard (
  ref_key text not null,
  platform text not null check (char_length(platform) > 0 and char_length(platform) <= 32),
  posted_at timestamptz,
  publisher_ref text,
  lease_until timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (ref_key, platform)
);

create index if not exists marketing_publish_guard_posted_at_idx
  on marketing_publish_guard (posted_at)
  where posted_at is not null;

comment on table marketing_publish_guard is 'Authoritative marketing post idempotency; extend with migrate_marketing_publish_guard_state.sql (publishing → posted).';

-- Claim a publish slot (lease) or reject if already posted / another worker holds lease.
create or replace function marketing_acquire_publish_slot(p_ref_key text, p_platform text, p_lease_sec int)
returns jsonb
language plpgsql
as $$
declare
  v_ins int;
  v_posted timestamptz;
  v_lease timestamptz;
  v_sec int;
begin
  if p_ref_key is null or length(trim(p_ref_key)) = 0 then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_ref');
  end if;
  if p_platform is null or length(trim(p_platform)) = 0 then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_platform');
  end if;
  v_sec := greatest(30, least(900, coalesce(p_lease_sec, 180)));

  insert into marketing_publish_guard (ref_key, platform, lease_until, updated_at)
  values (trim(p_ref_key), lower(trim(p_platform)), now() + make_interval(secs => v_sec), now())
  on conflict (ref_key, platform) do nothing;
  get diagnostics v_ins = row_count;

  select posted_at, lease_until into strict v_posted, v_lease
  from marketing_publish_guard
  where ref_key = trim(p_ref_key) and platform = lower(trim(p_platform))
  for update;

  if v_posted is not null then
    return jsonb_build_object('allowed', false, 'reason', 'already_posted');
  end if;

  if v_ins > 0 then
    return jsonb_build_object('allowed', true, 'reason', 'claimed_new');
  end if;

  if v_lease is not null and v_lease > now() then
    return jsonb_build_object('allowed', false, 'reason', 'lease_active');
  end if;

  update marketing_publish_guard
  set
    lease_until = now() + make_interval(secs => v_sec),
    updated_at = now()
  where ref_key = trim(p_ref_key) and platform = lower(trim(p_platform));

  return jsonb_build_object('allowed', true, 'reason', 'claimed_expired_lease');
end;
$$;

-- After provider call: mark posted (success) or release lease (failure).
create or replace function marketing_complete_publish(
  p_ref_key text,
  p_platform text,
  p_success boolean,
  p_publisher_ref text,
  p_error text
)
returns jsonb
language plpgsql
as $$
declare
  v_err text;
begin
  v_err := left(coalesce(p_error, ''), 2000);
  if p_success then
    update marketing_publish_guard
    set
      posted_at = now(),
      publisher_ref = left(coalesce(p_publisher_ref, ''), 512),
      lease_until = null,
      last_error = null,
      updated_at = now()
    where ref_key = trim(p_ref_key) and platform = lower(trim(p_platform));
  else
    update marketing_publish_guard
    set
      lease_until = null,
      last_error = v_err,
      updated_at = now()
    where ref_key = trim(p_ref_key) and platform = lower(trim(p_platform));
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Fast read for UI / pre-checks (no lock).
create or replace function marketing_publish_is_done(p_ref_key text, p_platform text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from marketing_publish_guard
    where ref_key = trim(p_ref_key)
      and platform = lower(trim(p_platform))
      and posted_at is not null
  );
$$;
