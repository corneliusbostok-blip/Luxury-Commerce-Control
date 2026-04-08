alter table if exists products
  add column if not exists image_urls jsonb not null default '[]'::jsonb,
  add column if not exists supplier_variants jsonb not null default '[]'::jsonb,
  add column if not exists available boolean not null default true,
  add column if not exists availability_reason text not null default '',
  add column if not exists supplier_last_checked_at timestamptz null,
  add column if not exists supplier_sync_error text not null default '';

create index if not exists products_available_idx on products (available);
create index if not exists products_supplier_checked_idx on products (supplier_last_checked_at);

