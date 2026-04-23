-- ForgePoint Signal: regulatory_entries table
-- Run this in Supabase SQL editor or via `supabase db push`.

create extension if not exists "pgcrypto";

create table if not exists public.regulatory_entries (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  published_date  date,
  source          text,
  jurisdiction    text,
  category        text,
  title           text,
  summary         text,
  source_url      text,
  effective_date  date,
  impact_level    text,
  raw_json        jsonb
);

create index if not exists regulatory_entries_published_date_idx
  on public.regulatory_entries (published_date desc);

create index if not exists regulatory_entries_category_idx
  on public.regulatory_entries (category);

create index if not exists regulatory_entries_jurisdiction_idx
  on public.regulatory_entries (jurisdiction);

alter table public.regulatory_entries enable row level security;

-- Public read access (API uses anon key). Writes restricted to service role.
drop policy if exists "regulatory_entries_read" on public.regulatory_entries;
create policy "regulatory_entries_read"
  on public.regulatory_entries
  for select
  to anon, authenticated
  using (true);
