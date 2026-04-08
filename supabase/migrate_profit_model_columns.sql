alter table if exists products
  add column if not exists estimated_shipping_cost numeric(12,2) not null default 0,
  add column if not exists return_risk_proxy numeric(12,2) not null default 0,
  add column if not exists unit_profit numeric(12,2) not null default 0,
  add column if not exists margin_pct numeric(8,2) not null default 0,
  add column if not exists add_to_cart_count integer not null default 0;
