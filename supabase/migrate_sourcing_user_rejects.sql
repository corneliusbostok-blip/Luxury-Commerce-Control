-- Husk produkter brugeren har fjernet fra shop (dashboard Remove), så sourcing ikke finder "det samme" igen.
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
