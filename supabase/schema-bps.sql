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

-- Added for the automated capture worker (M6).
--
-- quality     the worker's own assessment: a 0..1 score, the signals behind it
--             and, importantly, the reasons in words. A number nobody can act
--             on is decoration; the reasons are what make a flag reviewable.
-- flagged     denormalised out of quality so the review queue is an index scan
--             rather than a jsonb predicate over every row in the event.
-- raw_reads   the UNGATED per-second observations, ~163 rows of small numbers.
--             This is what replaces keeping the video: the likely class of
--             future bug is in the gate, the clock or the resync rules, and all
--             of those can be re-run from these without the footage existing.
alter table public.cv_logs add column if not exists quality    jsonb;
alter table public.cv_logs add column if not exists flagged    boolean not null default false;
alter table public.cv_logs add column if not exists raw_reads  jsonb;

-- The review queue: flagged logs for an event, worst first.
create index if not exists cv_logs_flagged_idx
  on public.cv_logs (event_key, flagged)
  where flagged;

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

-- ---------------------------------------------------------------------------
-- Scoreboard layout calibration
--
-- A broadcast's scoreboard geometry, taught once per event by a human and then
-- reused for every match at that event. This exists because inferring the
-- geometry from pixels is where this pipeline keeps failing: a two-row
-- scoreboard cost a full night of work and two wrong fixes, while a person
-- looking at one frame can say "the scores are the bottom row" instantly.
--
-- Keyed by event because layouts vary by competition AND by season -- the same
-- venue can re-skin its overlay between years -- so `season` is stored
-- explicitly rather than parsed out of the key at read time, and a layout is
-- never reused across seasons without a human confirming it.
-- ---------------------------------------------------------------------------
create table if not exists public.cv_layouts (
  event_key    text primary key,
  season       int  not null,
  label        text,
  -- The nine boxes, each {x0,y0,x1,y1} as fractions of frame size, so a layout
  -- calibrated on 1080p still applies to a 720p feed of the same broadcast.
  boxes        jsonb not null,
  -- What it was calibrated against, for judging whether it still applies.
  source_label text,
  frame_size   jsonb,
  -- Result of the "read one finished match and compare with TBA" check.
  verified     jsonb,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists cv_layouts_season_idx on public.cv_layouts (season);

-- Every correction a human made to what the detector proposed.
--
-- The detector currently has four Glendale clips as its entire regression set.
-- Each row here is a worked example of a layout it got wrong, captured for free
-- while a person was already looking -- useful immediately as test cases, and
-- as training data later if that is ever wanted.
create table if not exists public.cv_layout_corrections (
  id         bigserial primary key,
  event_key  text not null,
  season     int  not null,
  element    text not null,
  -- null when the detector proposed nothing at all, which is itself the signal.
  proposed   jsonb,
  corrected  jsonb not null,
  -- How far the human had to move it, as fractions. A correction that repeats
  -- across events is one detector bug with several witnesses, not several bugs.
  delta      jsonb,
  created_at timestamptz not null default now()
);

create index if not exists cv_layout_corrections_event_idx on public.cv_layout_corrections (event_key);
create index if not exists cv_layout_corrections_element_idx on public.cv_layout_corrections (element);

drop trigger if exists cv_layouts_touch on public.cv_layouts;
create trigger cv_layouts_touch
  before update on public.cv_layouts
  for each row execute function public.touch_updated_at();

alter table public.cv_layouts             enable row level security;
alter table public.cv_layout_corrections  enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['cv_layouts', 'cv_layout_corrections']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_anon_all', t);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (true) with check (true)',
      t || '_anon_all', t
    );
  end loop;
end;
$$;
