-- Publishing state layer: mark "publishing" BEFORE external API, "posted" after.
-- Prevents double side-effects when complete_publish lags: recent "publishing" blocks repost.

alter table marketing_publish_guard
  add column if not exists outbound_status text,
  add column if not exists publishing_started_at timestamptz;

comment on column marketing_publish_guard.outbound_status is 'publishing | posted (mirror of posted_at for clarity)';
comment on column marketing_publish_guard.publishing_started_at is 'Set before TikTok/Meta call; recent = uncertain, do not repost.';

-- Claim lease (unchanged semantics) + block if another worker is mid-flight (recent publishing).
create or replace function marketing_acquire_publish_slot(p_ref_key text, p_platform text, p_lease_sec int)
returns jsonb
language plpgsql
as $$
declare
  v_ins int;
  v_posted timestamptz;
  v_lease timestamptz;
  v_sec int;
  v_status text;
  v_pub_start timestamptz;
  v_uncertainty_sec int := 1800;
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

  select posted_at, lease_until, outbound_status, publishing_started_at
  into strict v_posted, v_lease, v_status, v_pub_start
  from marketing_publish_guard
  where ref_key = trim(p_ref_key) and platform = lower(trim(p_platform))
  for update;

  if v_posted is not null then
    return jsonb_build_object('allowed', false, 'reason', 'already_posted');
  end if;

  if v_status = 'publishing' and v_pub_start is not null
     and v_pub_start > now() - make_interval(secs => v_uncertainty_sec) then
    return jsonb_build_object('allowed', false, 'reason', 'uncertain_publishing');
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

-- MUST succeed before calling TikTok/Meta. Sets status=publishing + started_at.
-- Recent publishing from another worker → uncertain (no second side-effect).
-- Stale publishing (> p_uncertainty_sec) → reclaim row for a new attempt (logged in last_error prefix).
create or replace function marketing_begin_outbound_publish(
  p_ref_key text,
  p_platform text,
  p_uncertainty_sec int
)
returns jsonb
language plpgsql
as $$
declare
  v_posted timestamptz;
  v_status text;
  v_pub_start timestamptz;
  v_unc int;
begin
  if p_ref_key is null or length(trim(p_ref_key)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_ref');
  end if;
  if p_platform is null or length(trim(p_platform)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_platform');
  end if;
  v_unc := greatest(60, least(86400, coalesce(p_uncertainty_sec, 1800)));

  select posted_at, outbound_status, publishing_started_at
  into strict v_posted, v_status, v_pub_start
  from marketing_publish_guard
  where ref_key = trim(p_ref_key) and platform = lower(trim(p_platform))
  for update;

  if v_posted is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_posted');
  end if;

  if v_status = 'publishing' and v_pub_start is not null then
    if v_pub_start > now() - make_interval(secs => v_unc) then
      return jsonb_build_object('ok', false, 'reason', 'uncertain_publishing');
    end if;
    update marketing_publish_guard
    set
      outbound_status = null,
      publishing_started_at = null,
      last_error = left(concat('stale_reclaim | ', coalesce(last_error, '')), 2000),
      updated_at = now()
    where ref_key = trim(p_ref_key) and platform = lower(trim(p_platform));
  end if;

  update marketing_publish_guard
  set
    outbound_status = 'publishing',
    publishing_started_at = now(),
    updated_at = now()
  where ref_key = trim(p_ref_key) and platform = lower(trim(p_platform));

  return jsonb_build_object('ok', true, 'reason', 'publishing_marked', 'started_at', now());
end;
$$;

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
      outbound_status = 'posted',
      publishing_started_at = null,
      publisher_ref = left(coalesce(p_publisher_ref, ''), 512),
      lease_until = null,
      last_error = null,
      updated_at = now()
    where ref_key = trim(p_ref_key) and platform = lower(trim(p_platform));
  else
    update marketing_publish_guard
    set
      lease_until = null,
      outbound_status = null,
      publishing_started_at = null,
      last_error = v_err,
      updated_at = now()
    where ref_key = trim(p_ref_key) and platform = lower(trim(p_platform));
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
