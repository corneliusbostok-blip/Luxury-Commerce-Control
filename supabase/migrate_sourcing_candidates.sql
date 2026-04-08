create table if not exists sourcing_candidates (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decision_reason text not null default '',
  source_platform text not null default '',
  source_query text not null default '',
  ai_score double precision not null default 0,
  risk_score double precision not null default 0,
  ranking_score double precision not null default 0,
  candidate_payload jsonb not null default '{}'::jsonb,
  reviewed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sourcing_candidates_status_created_idx
  on sourcing_candidates(status, created_at desc);

create or replace function set_sourcing_candidates_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_sourcing_candidates_updated_at on sourcing_candidates;
create trigger trg_sourcing_candidates_updated_at
before update on sourcing_candidates
for each row
execute function set_sourcing_candidates_updated_at();
