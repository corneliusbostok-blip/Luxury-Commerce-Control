alter table products
  add column if not exists rank_state text not null default 'normal',
  add column if not exists rank_last_changed_at timestamptz null,
  add column if not exists rank_low_since timestamptz null;

create index if not exists products_rank_state_idx on products(rank_state);
