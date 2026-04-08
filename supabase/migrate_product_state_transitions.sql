create table if not exists product_state_transitions (
  id bigserial primary key,
  product_id uuid not null,
  from_status text,
  to_status text,
  from_sourcing text,
  to_sourcing text,
  reason text,
  actor_type text not null default 'system',
  actor_id text,
  cycle_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_product_state_transitions_product_id
  on product_state_transitions(product_id, created_at desc);
