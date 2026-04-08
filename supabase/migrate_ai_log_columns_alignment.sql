alter table if exists ai_log
  add column if not exists created_at timestamptz null,
  add column if not exists product_id uuid null,
  add column if not exists cycle_id text null,
  add column if not exists metadata jsonb null,
  add column if not exists reason text null,
  add column if not exists ai_confidence numeric null,
  add column if not exists before jsonb null,
  add column if not exists after jsonb null;

update ai_log
set created_at = now()
where created_at is null;

alter table if exists ai_log
  alter column created_at set default now(),
  alter column created_at set not null;

create index if not exists ai_log_created_idx on ai_log (created_at desc);
