create table if not exists store_config (
  key text primary key,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
