-- Velden — quiet luxury men's fashion (Supabase SQL Editor, once)

create extension if not exists "pgcrypto";

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  cost numeric(12,2) not null default 0,
  price numeric(12,2) not null default 0,
  score numeric(12,4) not null default 0,
  status text not null default 'active',
  brand text,
  description text,
  selling_points text,
  image_url text,
  category text not null default 'other',
  color text not null default '',
  sizes text not null default 'S,M,L,XL',
  source_platform text not null default '',
  source_name text not null default '',
  source_url text not null default '',
  source_product_id text not null default '',
  supplier_name text not null default '',
  supplier_country text not null default '',
  import_method text not null default '',
  ai_fit_score integer not null default 0 check (ai_fit_score >= 0 and ai_fit_score <= 100),
  brand_fit_reason text not null default '',
  sourcing_status text not null default 'draft',
  external_id text,
  style_key text not null default '',
  color_variants jsonb not null default '[]'::jsonb,
  views integer not null default 0,
  clicks integer not null default 0,
  orders_count integer not null default 0,
  seo_meta_title text not null default '',
  seo_meta_description text not null default '',
  tiktok_script text,
  captions text,
  hashtags text,
  stripe_price_cents integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists products_status_idx on products (status);
create index if not exists products_score_idx on products (score desc);
create index if not exists products_category_idx on products (category);
create index if not exists products_color_idx on products (color);
create index if not exists products_sourcing_status_idx on products (sourcing_status);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete set null,
  line_items jsonb,
  status text not null default 'pending',
  stripe_session_id text unique,
  amount_cents integer,
  currency text default 'usd',
  customer_email text,
  supplier_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists orders_product_idx on orders (product_id);

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

create table if not exists ai_log (
  id bigserial primary key,
  action text not null,
  created_at timestamptz not null default now(),
  details jsonb
);

create index if not exists ai_log_created_idx on ai_log (created_at desc);

create table if not exists ai_memory (
  id uuid primary key default gen_random_uuid(),
  insight text not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_memory_created_idx on ai_memory (created_at desc);

create table if not exists sourcing_user_rejects (
  id uuid primary key default gen_random_uuid(),
  external_id text not null default '',
  source_url text not null default '',
  supplier_host text not null default '',
  title_normalized text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists sourcing_user_rejects_external_idx on sourcing_user_rejects (external_id)
  where external_id <> '';
create index if not exists sourcing_user_rejects_host_idx on sourcing_user_rejects (supplier_host)
  where supplier_host <> '';
create index if not exists sourcing_user_rejects_created_idx on sourcing_user_rejects (created_at desc);

-- Semi-automatic eBay fulfillment inbox (see migrate_fulfillment_queue.sql).
create table if not exists fulfillment_queue (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  product_id text not null,
  supplier text not null check (supplier in ('ebay', 'shopify')),
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  supplier_url text not null default '',
  variant_data jsonb not null default '{}'::jsonb,
  customer_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists fulfillment_queue_status_created_idx
  on fulfillment_queue (status, created_at desc);
create unique index if not exists fulfillment_queue_order_product_pending_uniq
  on fulfillment_queue (order_id, product_id)
  where status = 'pending';

-- Server-only access (SUPABASE_SERVICE_ROLE_KEY).
