-- ===================================================================
-- "Current event" — additive migration
--
-- Run this in the Supabase SQL editor AFTER schema.sql and
-- schema-bps.sql. It only adds a column and touches no existing data.
--
-- Why: "selected event" was purely per-device localStorage, set only
-- by the admin screen (Match Selection). A scouter's device never
-- independently sets it, so every event-scoped read on a scouter's
-- browser (matches, timelines, CV logs) fell back to "no event
-- selected -> show everything", silently blending whichever events
-- that device's local cache happened to hold -- e.g. a scouter's
-- Match Schedule showing two different events' Qualification 1 at
-- once. Marking one event "current" server-side lets every device
-- converge on the same event the admin actually has active, the same
-- way matches/timelines/scouters already sync.
-- ===================================================================

alter table public.events add column if not exists is_current boolean not null default false;

-- At most one current event at a time.
create unique index if not exists events_single_current_idx
  on public.events ((is_current))
  where is_current;
