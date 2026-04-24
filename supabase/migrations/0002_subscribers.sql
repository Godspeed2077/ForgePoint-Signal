-- ForgePoint Signal: subscribers table
-- Stores one row per Stripe customer who has ever checked out.
-- The webhook at POST /webhook upserts rows here; the magic-link
-- auth flow reads status to decide whether to send a login email.

create extension if not exists "pgcrypto";

create table if not exists public.subscribers (
  id                      uuid primary key default gen_random_uuid(),
  email                   text not null,
  stripe_customer_id      text,
  stripe_subscription_id  text,
  status                  text not null default 'inactive',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Case-insensitive uniqueness on email so "Foo@Bar.com" and "foo@bar.com"
-- collapse into one subscriber. The application also lowercases before
-- writing, but the index is the ultimate guardrail.
create unique index if not exists subscribers_email_lower_uniq
  on public.subscribers (lower(email));

create unique index if not exists subscribers_stripe_customer_uniq
  on public.subscribers (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists subscribers_stripe_subscription_uniq
  on public.subscribers (stripe_subscription_id)
  where stripe_subscription_id is not null;

create index if not exists subscribers_status_idx
  on public.subscribers (status);

-- Keep updated_at fresh on every row change.
create or replace function public.subscribers_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists subscribers_touch_updated_at on public.subscribers;
create trigger subscribers_touch_updated_at
  before update on public.subscribers
  for each row execute function public.subscribers_touch_updated_at();

-- RLS on. The API writes with the service-role key, which bypasses RLS.
-- No public read policies — subscription state is read server-side only.
alter table public.subscribers enable row level security;
