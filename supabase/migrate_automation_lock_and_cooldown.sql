create table if not exists automation_locks (
  key text primary key,
  expires_at timestamptz not null
);

alter table products
  add column if not exists cooldown_until timestamptz;
