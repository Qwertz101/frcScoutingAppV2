-- ---------------------------------------------------------------------------
-- FRC Scouting App — Supabase schema
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: everything is IF NOT EXISTS / OR REPLACE.
--
-- Column names below are taken directly from src/services/syncService.ts, which
-- already sends these exact shapes. Renaming anything here will break sync.
--
-- SECURITY NOTE — READ BEFORE DEPLOYING PUBLICLY
-- This app talks to Supabase with a *publishable* key that is embedded in the
-- built JavaScript and is therefore visible to anyone who loads the site. The
-- policies below consequently grant the anonymous role full read/write on
-- scouting data. That is inherent to how this app is currently designed, not
-- something this schema introduces. Anyone who has the site URL can read and
-- modify scouting data. If that matters to you, put the app behind Supabase Auth
-- and replace the `USING (true)` policies with per-user checks.
-- ---------------------------------------------------------------------------

-- Needed for gen_random_uuid()
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Shared updated_at touch trigger
-- syncService orders by updated_at (scouters, matches) but does not always send
-- it, so the database maintains it.
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- events
-- pushMatchesToServer upserts minimal rows of just { key } to satisfy the
-- matches.event_key foreign key, so every column except key must be nullable.
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  key         text primary key,
  name        text,
  start_date  date,
  end_date    date,
  updated_at  timestamptz not null default now()
);

drop trigger if exists events_touch_updated_at on public.events;
create trigger events_touch_updated_at
  before update on public.events
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- matches
-- `alliances` stores the TBA shape: { red: { team_keys: [...] }, blue: {...} }
-- Deletions are soft (deleted_at) so other clients can pick them up.
-- ---------------------------------------------------------------------------
create table if not exists public.matches (
  key           text primary key,
  event_key     text references public.events (key) on delete cascade,
  match_number  integer,
  comp_level    text,
  alliances     jsonb not null default '{}'::jsonb,
  deleted_at    timestamptz,
  updated_at    timestamptz not null default now()
);

create index if not exists matches_event_key_idx on public.matches (event_key);
create index if not exists matches_updated_at_idx on public.matches (updated_at desc);

drop trigger if exists matches_touch_updated_at on public.matches;
create trigger matches_touch_updated_at
  before update on public.matches
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- scouting_records
-- One row per scouter per team per match. `payload` holds { auto, teleop,
-- endgame, defense } and, for rows created by the stats-CSV importer, the
-- provenance flags { synthetic: true, syntheticSource: '...' }.
-- ---------------------------------------------------------------------------
create table if not exists public.scouting_records (
  id            uuid primary key default gen_random_uuid(),
  match_key     text not null,
  team_key      text not null,
  scouter_name  text,
  alliance      text,
  position      integer,
  payload       jsonb not null default '{}'::jsonb,
  client_id     text,
  timestamp     timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists scouting_records_team_key_idx  on public.scouting_records (team_key);
create index if not exists scouting_records_match_key_idx on public.scouting_records (match_key);
create index if not exists scouting_records_timestamp_idx on public.scouting_records ("timestamp" desc);

-- Deliberately NO unique constraint on (match_key, team_key, scouter_name).
-- syncService upserts with onConflict:'id', so a collision on any *other*
-- unique index would raise an error it cannot resolve — which is exactly what
-- happens when the same scouter re-scouts from a second device and generates a
-- fresh id. Multiple rows per team/match are expected and handled: buildTeamMetrics
-- in src/utils/teamMetrics.ts averages them per match.

drop trigger if exists scouting_records_touch_updated_at on public.scouting_records;
create trigger scouting_records_touch_updated_at
  before update on public.scouting_records
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- scouters
-- ---------------------------------------------------------------------------
create table if not exists public.scouters (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  alliance    text,
  position    integer,
  is_remote   boolean not null default false,
  deleted_at  timestamptz,
  updated_at  timestamptz not null default now()
);

create index if not exists scouters_updated_at_idx on public.scouters (updated_at desc);

drop trigger if exists scouters_touch_updated_at on public.scouters;
create trigger scouters_touch_updated_at
  before update on public.scouters
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- pit_data
-- ---------------------------------------------------------------------------
create table if not exists public.pit_data (
  team_key    text primary key,
  payload     jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

drop trigger if exists pit_data_touch_updated_at on public.pit_data;
create trigger pit_data_touch_updated_at
  before update on public.pit_data
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- admins
-- LoginPage.tsx reads this table to check the admin password, falling back to a
-- hard-coded local password when the lookup fails. Passwords are stored in
-- plaintext by the app's existing design — do not reuse a real password here.
-- ---------------------------------------------------------------------------
create table if not exists public.admins (
  username    text primary key,
  password    text not null,
  updated_at  timestamptz not null default now()
);

drop trigger if exists admins_touch_updated_at on public.admins;
create trigger admins_touch_updated_at
  before update on public.admins
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- See the security note at the top of this file. RLS is enabled (rather than
-- left off) so the access grant is explicit and easy to tighten later.
-- ---------------------------------------------------------------------------
alter table public.events           enable row level security;
alter table public.matches          enable row level security;
alter table public.scouting_records enable row level security;
alter table public.scouters         enable row level security;
alter table public.pit_data         enable row level security;
alter table public.admins           enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['events', 'matches', 'scouting_records', 'scouters', 'pit_data']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_anon_all', t);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (true) with check (true)',
      t || '_anon_all', t
    );
  end loop;
end;
$$;

-- admins is read-only to clients: the app only ever SELECTs the password.
-- Manage rows from the Supabase dashboard.
drop policy if exists admins_anon_read on public.admins;
create policy admins_anon_read
  on public.admins for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- Storage bucket for pit images
-- syncService uploads to / lists from the `pit-images` bucket.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('pit-images', 'pit-images', true)
on conflict (id) do update set public = true;

drop policy if exists pit_images_anon_all on storage.objects;
create policy pit_images_anon_all
  on storage.objects for all to anon, authenticated
  using (bucket_id = 'pit-images')
  with check (bucket_id = 'pit-images');
