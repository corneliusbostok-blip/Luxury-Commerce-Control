create table if not exists discovery_product_performance (
  discovery_key text primary key,
  product_id uuid null,
  external_id text null,
  source_url text null,
  source_product_id text null,
  source_platform text not null default 'unknown',
  source_name text null,
  source_query text not null default '',
  selection_mode text not null default 'exploit',
  query_confidence text not null default 'low',
  category text not null default 'other',
  discovery_score numeric not null default 0,
  discoveries integer not null default 0,
  views integer not null default 0,
  clicks integer not null default 0,
  add_to_cart integer not null default 0,
  orders integer not null default 0,
  revenue numeric not null default 0,
  unit_profit_total numeric not null default 0,
  discovered_at timestamptz not null default now(),
  first_order_at timestamptz null,
  time_to_first_sale_seconds integer null,
  updated_at timestamptz not null default now()
);

create index if not exists discovery_perf_query_idx on discovery_product_performance (source_query);
create index if not exists discovery_perf_category_idx on discovery_product_performance (category);
create index if not exists discovery_perf_product_idx on discovery_product_performance (product_id);

