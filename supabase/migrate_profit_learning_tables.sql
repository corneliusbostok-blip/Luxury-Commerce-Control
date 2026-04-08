create table if not exists daily_metrics (
  date date primary key,
  revenue numeric not null default 0,
  profit numeric not null default 0,
  avg_score numeric not null default 0,
  product_count integer not null default 0
);

create table if not exists source_metrics (
  source_name text primary key,
  avg_profit numeric not null default 0,
  success_rate numeric not null default 0,
  updated_at timestamptz not null default now()
);

alter table products
  add column if not exists experiment_variant text check (experiment_variant in ('A', 'B'));
