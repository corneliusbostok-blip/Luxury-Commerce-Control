alter table if exists products
  add column if not exists discovery_mode text not null default 'unknown',
  add column if not exists source_query text not null default '';

alter table if exists discovery_product_performance
  add column if not exists selection_mode text not null default 'exploit',
  add column if not exists query_confidence text not null default 'low';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'products_discovery_mode_check'
  ) then
    alter table products
      add constraint products_discovery_mode_check
      check (discovery_mode in ('explore', 'exploit', 'unknown'));
  end if;
end
$$;

create table if not exists learning_metrics_daily (
  date date primary key,
  total_profit numeric not null default 0,
  active_product_count integer not null default 0,
  profit_per_sku numeric not null default 0,
  explore_revenue numeric not null default 0,
  explore_profit numeric not null default 0,
  explore_conversion_rate numeric not null default 0,
  exploit_revenue numeric not null default 0,
  exploit_profit numeric not null default 0,
  exploit_conversion_rate numeric not null default 0,
  explore_roi numeric not null default 0,
  exploit_roi numeric not null default 0,
  decision_accuracy numeric not null default 0,
  fallback_profit_per_sku numeric not null default 0,
  fallback_conversion_rate numeric not null default 0,
  normal_profit_per_sku numeric not null default 0,
  normal_conversion_rate numeric not null default 0,
  updated_at timestamptz not null default now()
);

