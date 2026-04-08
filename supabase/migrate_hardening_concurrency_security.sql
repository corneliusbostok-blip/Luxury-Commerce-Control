create unique index if not exists orders_stripe_session_id_unique
  on orders (stripe_session_id)
  where stripe_session_id is not null;

create unique index if not exists products_external_id_unique
  on products (external_id)
  where external_id is not null and external_id <> '';

create or replace function increment_product_counters(
  p_product_id uuid,
  p_views_inc integer default 0,
  p_clicks_inc integer default 0,
  p_orders_inc integer default 0
)
returns table (
  id uuid,
  views integer,
  clicks integer,
  orders_count integer
)
language sql
as $$
  update products
  set
    views = coalesce(views, 0) + greatest(coalesce(p_views_inc, 0), 0),
    clicks = coalesce(clicks, 0) + greatest(coalesce(p_clicks_inc, 0), 0),
    orders_count = coalesce(orders_count, 0) + greatest(coalesce(p_orders_inc, 0), 0),
    updated_at = now()
  where products.id = p_product_id
  returning products.id, products.views, products.clicks, products.orders_count;
$$;

create table if not exists sourcing_chat_sessions (
  session_id text primary key,
  raw_candidate jsonb not null default '{}'::jsonb,
  eval_result jsonb not null default '{}'::jsonb,
  last_hint text not null default '',
  last_category_intent text null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists sourcing_chat_sessions_updated_at_idx
  on sourcing_chat_sessions(updated_at desc);

create table if not exists checkout_session_process_log (
  stripe_session_id text primary key,
  order_id uuid not null,
  processed_at timestamptz not null default now()
);

create or replace function process_checkout_session_atomic(
  p_stripe_session_id text,
  p_product_id uuid,
  p_line_items jsonb,
  p_amount_cents integer,
  p_currency text,
  p_customer_email text,
  p_supplier_data jsonb,
  p_checkout_draft_id uuid
)
returns table (order_id uuid, duplicate boolean)
language plpgsql
as $$
declare
  v_order_id uuid;
  v_row jsonb;
  v_pid uuid;
  v_qty integer;
begin
  select c.order_id into v_order_id
  from checkout_session_process_log c
  where c.stripe_session_id = p_stripe_session_id;
  if v_order_id is not null then
    return query select v_order_id, true;
    return;
  end if;

  insert into orders (product_id, line_items, status, stripe_session_id, amount_cents, currency, customer_email, supplier_data)
  values (p_product_id, p_line_items, 'paid', p_stripe_session_id, p_amount_cents, p_currency, p_customer_email, p_supplier_data)
  on conflict (stripe_session_id) do update set stripe_session_id = excluded.stripe_session_id
  returning id into v_order_id;

  if p_line_items is not null then
    for v_row in select * from jsonb_array_elements(p_line_items)
    loop
      v_pid := nullif(v_row->>'product_id', '')::uuid;
      v_qty := greatest(coalesce((v_row->>'quantity')::integer, 1), 1);
      if v_pid is not null then
        update products
        set orders_count = coalesce(orders_count, 0) + v_qty,
            updated_at = now()
        where id = v_pid;
      end if;
    end loop;
  elsif p_product_id is not null then
    update products
    set orders_count = coalesce(orders_count, 0) + 1,
        updated_at = now()
    where id = p_product_id;
  end if;

  if p_checkout_draft_id is not null then
    delete from checkout_drafts where id = p_checkout_draft_id;
  end if;

  insert into checkout_session_process_log (stripe_session_id, order_id)
  values (p_stripe_session_id, v_order_id)
  on conflict (stripe_session_id) do nothing;

  return query select v_order_id, false;
end;
$$;
