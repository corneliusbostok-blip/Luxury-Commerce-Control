-- Semi-automatic eBay fulfillment inbox (Shopify stays webhook-based).

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

comment on table fulfillment_queue is 'eBay (and future) manual fulfillment rows; Shopify uses webhooks only.';
