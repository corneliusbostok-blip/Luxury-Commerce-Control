-- Run in Supabase if upgrading an older project

alter table products add column if not exists color text not null default '';
alter table products add column if not exists sizes text not null default 'S,M,L,XL';

create index if not exists products_color_idx on products (color);

alter table orders add column if not exists line_items jsonb;

create table if not exists checkout_drafts (
  id uuid primary key default gen_random_uuid(),
  items jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);
