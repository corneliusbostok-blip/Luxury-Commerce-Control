create table if not exists price_elasticity (
  id bigserial primary key,
  product_id uuid not null,
  category text,
  old_price numeric not null,
  new_price numeric not null,
  before_conversion numeric,
  after_conversion numeric,
  cycle_id text,
  observed_at timestamptz not null default now()
);

create index if not exists idx_price_elasticity_product_time
  on price_elasticity(product_id, observed_at desc);
