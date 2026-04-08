create table if not exists ai_ceo_runs (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('light', 'full')),
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_ceo_runs_created_at_idx
  on ai_ceo_runs (created_at desc);
