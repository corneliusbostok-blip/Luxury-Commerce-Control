create table if not exists decision_ledger (
  id bigserial primary key,
  cycle_id text,
  decision_type text not null,
  product_id uuid,
  category text,
  source_name text,
  hypothesis text,
  expected_effect text,
  confidence numeric,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_decision_ledger_cycle on decision_ledger(cycle_id, created_at desc);

create table if not exists experiments (
  id bigserial primary key,
  experiment_key text unique,
  variant_a text,
  variant_b text,
  winner_variant text,
  status text not null default 'running',
  context jsonb,
  close_reason text,
  started_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists experiment_results (
  id bigserial primary key,
  experiment_id bigint references experiments(id) on delete set null,
  winner_variant text,
  loser_variant text,
  evidence jsonb,
  created_at timestamptz not null default now()
);

create table if not exists category_learning (
  category text primary key,
  avg_profit numeric,
  avg_conversion numeric,
  price_sensitivity numeric,
  experiment_win_rate numeric,
  source_success_concentration numeric,
  updated_at timestamptz not null default now()
);

create table if not exists cycle_outcomes (
  id bigserial primary key,
  cycle_id text unique,
  profit_delta numeric,
  conversion_delta numeric,
  margin_delta numeric,
  decision_quality_score numeric,
  stability_penalty numeric,
  rollback_penalty numeric,
  created_at timestamptz not null default now()
);
