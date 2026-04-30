-- Kayzo -- contractor_integrations
-- Stores per-contractor integration credentials for Gmail, Lowe's, and Home Depot.
-- Run: supabase db push

create table if not exists contractor_integrations (
  id                        uuid primary key default gen_random_uuid(),
  license_key               text not null unique,

  -- Gmail (OAuth)
  gmail_connected           boolean not null default false,
  gmail_email               text,
  gmail_refresh_token       text,
  gmail_access_token        text,
  gmail_token_expiry        timestamptz,
  gmail_oauth_state         text,   -- short-lived CSRF nonce during OAuth flow

  -- Lowe's Pro
  lowes_api_key             text,
  lowes_account_number      text,

  -- Home Depot Pro
  homedepot_api_key         text,
  homedepot_account_number  text,

  updated_at                timestamptz not null default now()
);

alter table contractor_integrations enable row level security;

-- Auto-create integrations row when a customer is provisioned
create or replace function create_default_integrations()
returns trigger language plpgsql as $$
begin
  insert into contractor_integrations (license_key)
  values (new.license_key)
  on conflict (license_key) do nothing;
  return new;
end;
$$;

create trigger trg_customer_create_integrations
  after insert on customers
  for each row execute function create_default_integrations();
