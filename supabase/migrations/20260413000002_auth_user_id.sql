-- Kayzo -- Add auth_user_id to customers
-- Required by the kayzo-router to verify JWT sub against the customer record

alter table customers
  add column if not exists auth_user_id uuid;

-- Index for fast slug + auth_user_id lookups from the router
create index if not exists customers_slug_idx on customers (slug);
create index if not exists customers_auth_user_id_idx on customers (auth_user_id);
