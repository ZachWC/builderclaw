-- Kayzo MVP -- Initial Schema
-- Run: supabase db push

-- ─── customers ────────────────────────────────────────────────────────────────

create table if not exists customers (
  id                   uuid primary key default gen_random_uuid(),
  email                text not null unique,
  name                 text,
  slug                 text unique,
  stripe_customer_id   text,
  license_key          text not null unique default gen_random_uuid()::text,
  subscription_status  text not null default 'trialing',
  subscription_tier    text not null default 'cloud',
  free_account         boolean not null default false,
  monthly_token_budget integer not null default 500000,
  current_version      text,
  provisioned_port     integer,
  gateway_type         text not null default 'cloud',
  gateway_url          text default null,
  created_at           timestamptz not null default now()
);

alter table customers enable row level security;

-- ─── contractor_preferences ───────────────────────────────────────────────────

create table if not exists contractor_preferences (
  id                  uuid primary key default gen_random_uuid(),
  license_key         text not null unique,
  ordering_mode       text not null default 'always_ask',
  ordering_threshold  integer default 500,
  scheduling_mode     text not null default 'always_ask',
  scheduling_threshold integer default null,
  email_replies_mode  text not null default 'always_ask',
  flagging_mode       text not null default 'always_act',
  bid_markup          integer not null default 20,
  updated_at          timestamptz not null default now()
);

alter table contractor_preferences enable row level security;

-- Auto-create preferences row when a customer is provisioned
create or replace function create_default_preferences()
returns trigger language plpgsql as $$
begin
  insert into contractor_preferences (license_key)
  values (new.license_key)
  on conflict (license_key) do nothing;
  return new;
end;
$$;

create trigger trg_customer_create_preferences
  after insert on customers
  for each row execute function create_default_preferences();

-- ─── contractor_memory ────────────────────────────────────────────────────────

create table if not exists contractor_memory (
  id          uuid primary key default gen_random_uuid(),
  license_key text not null unique,
  memory_data jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);

alter table contractor_memory enable row level security;

-- ─── license_checks ───────────────────────────────────────────────────────────

create table if not exists license_checks (
  id          uuid primary key default gen_random_uuid(),
  license_key text not null,
  checked_at  timestamptz not null default now(),
  result      text not null
);

alter table license_checks enable row level security;

-- ─── usage_logs ───────────────────────────────────────────────────────────────

create table if not exists usage_logs (
  id            uuid primary key default gen_random_uuid(),
  license_key   text not null,
  month         text not null,           -- 'YYYY-MM'
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  updated_at    timestamptz not null default now(),
  unique (license_key, month)
);

alter table usage_logs enable row level security;

-- Atomic upsert called by the log-usage Edge Function
create or replace function increment_usage(
  p_license_key   text,
  p_month         text,
  p_input_tokens  integer,
  p_output_tokens integer
)
returns void language plpgsql as $$
begin
  insert into usage_logs (license_key, month, input_tokens, output_tokens, updated_at)
  values (p_license_key, p_month, p_input_tokens, p_output_tokens, now())
  on conflict (license_key, month)
  do update set
    input_tokens  = usage_logs.input_tokens  + excluded.input_tokens,
    output_tokens = usage_logs.output_tokens + excluded.output_tokens,
    updated_at    = now();
end;
$$;
