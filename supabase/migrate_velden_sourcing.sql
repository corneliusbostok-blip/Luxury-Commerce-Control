-- Velden: product sourcing metadata + sourcing_status (draft | approved | rejected)
-- Run in Supabase SQL Editor after schema.sql / existing DB.

alter table products add column if not exists source_platform text not null default '';
alter table products add column if not exists source_name text not null default '';
alter table products add column if not exists source_url text not null default '';
alter table products add column if not exists source_product_id text not null default '';
alter table products add column if not exists supplier_name text not null default '';
alter table products add column if not exists supplier_country text not null default '';
alter table products add column if not exists import_method text not null default '';
alter table products add column if not exists ai_fit_score integer not null default 0
  check (ai_fit_score >= 0 and ai_fit_score <= 100);
alter table products add column if not exists brand_fit_reason text not null default '';
alter table products add column if not exists sourcing_status text not null default 'approved';

-- Legacy storefront rows: treat as already approved for Velden.
update products set sourcing_status = 'approved' where sourcing_status is null or sourcing_status = '';

create index if not exists products_sourcing_status_idx on products (sourcing_status);

-- Align category slugs with current Velden taxonomy
update products set category = 'shoes' where category = 'footwear';
update products set category = 'accessories' where category = 'bags';
