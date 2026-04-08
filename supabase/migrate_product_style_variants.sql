-- Group colour variants of the same style (e.g. Slim Leg Straight Chinos) under one product row.

alter table products add column if not exists style_key text not null default '';
alter table products add column if not exists color_variants jsonb not null default '[]'::jsonb;

create index if not exists products_style_cat_idx on products (category, style_key)
  where style_key <> '' and coalesce(status, '') <> 'removed';
