-- ===================================================================
-- Time-windowed BPS scouting — additive migration
--
-- Run this in the Supabase SQL editor AFTER schema.sql. It only adds
-- tables; nothing here touches or drops the existing scouting tables,
-- so the current season's data is unaffected.
--
-- RLS note: same posture as the rest of the app. The client ships a
-- publishable key inside its bundle, so these policies allow anon
-- read/write. Anyone with the site URL can write to these tables. That
-- is inherent to how this app authenticates, not something this
-- migration introduces.
-- ===================================================================

-- Stream 1 — one robot's action timeline for one match.
-- Mirrors scouting_records' column names so both streams read alike.
create table if not exists public.timeline_records (
  id            uuid primary key default gen_random_uuid(),
  match_key     text not null,
  team_key      text not null,
  scouter_name  text,
  alliance      text,
  position      integer,
  -- { segments: [{action,start,end}], climb, confidence, endedEarly, kind }
  payload       jsonb not null default '{}'::jsonb,
  client_id     text,
  timestamp     timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists timeline_records_team_key_idx  on public.timeline_records (team_key);
create index if not exists timeline_records_match_key_idx on public.timeline_records (match_key);
create index if not exists timeline_records_timestamp_idx on public.timeline_records ("timestamp" desc);

-- One timeline per scouter per robot per match. Re-scouting updates in
-- place instead of leaving the solver to dedupe conflicting copies.
create unique index if not exists timeline_records_unique_scout
  on public.timeline_records (match_key, team_key, scouter_name);

-- Stream 2 — the per-second CV scoreboard log for one match.
-- match_key is the primary key: one authoritative log per match, so a
-- re-processed video overwrites rather than accumulating duplicates.
create table if not exists public.cv_logs (
  match_key   text primary key,
  event_key   text,
  source      text,
  -- [{ sec, phase, blue, red, db, dr }, ...] — ~160 rows per match.
  samples     jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists cv_logs_event_key_idx on public.cv_logs (event_key);
create index if not exists cv_logs_updated_at_idx on public.cv_logs (updated_at desc);

-- Keep updated_at honest even when a client forgets to send it.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists timeline_records_touch on public.timeline_records;
create trigger timeline_records_touch
  before update on public.timeline_records
  for each row execute function public.touch_updated_at();

drop trigger if exists cv_logs_touch on public.cv_logs;
create trigger cv_logs_touch
  before update on public.cv_logs
  for each row execute function public.touch_updated_at();

alter table public.timeline_records enable row level security;
alter table public.cv_logs          enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['timeline_records', 'cv_logs']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_anon_all', t);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (true) with check (true)',
      t || '_anon_all', t
    );
  end loop;
end;
$$;
