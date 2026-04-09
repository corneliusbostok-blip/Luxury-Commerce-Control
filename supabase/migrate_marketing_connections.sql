create table if not exists marketing_connections (
  id uuid primary key default gen_random_uuid(),
  store_id text not null default 'active',
  platform text not null check (platform in ('facebook', 'instagram', 'tiktok')),
  access_token_enc text not null default '',
  refresh_token_enc text not null default '',
  expires_at timestamptz null,
  account_id text not null default '',
  page_id text not null default '',
  ig_user_id text not null default '',
  enabled boolean not null default true,
  auth_method text not null default '',
  connected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists marketing_connections_store_platform_uniq
  on marketing_connections (store_id, platform);

create index if not exists marketing_connections_store_enabled_idx
  on marketing_connections (store_id, enabled, platform);

create table if not exists marketing_oauth_states (
  state text primary key,
  store_id text not null default 'active',
  platform text not null check (platform in ('facebook', 'instagram', 'tiktok')),
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists marketing_oauth_states_expires_idx
  on marketing_oauth_states (expires_at);

