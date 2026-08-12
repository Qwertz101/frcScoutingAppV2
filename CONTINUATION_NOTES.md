# FRC Scouting App — Continuation Notes

Written 2026-08-12 to hand off to a fresh chat session. Read this first, then
check `git log --oneline -15` to confirm nothing has moved since.

## What this app is

`frcScoutingAppV2` — a React 18 + TypeScript + Vite PWA for FRC (FIRST Robotics
Competition) team 6560 "Charging Champions." Scouts use it at competitions to
record what robots do, and admins turn that into rankings/picklists. Backed by
Supabase (Postgres + storage), deployed to GitHub Pages.

**Real checkout:** `C:\Users\kianz\Documents\frcScoutingAppV2` — always work
here. `C:\Users\kianz\frcScoutingAppV2` (no `Documents`) is a stale duplicate
clone with no `node_modules`; a session that opens there and edits will
silently do nothing useful. Verify `pwd`/the tool's cwd before trusting it.

Dev server: `npm run dev` (Vite, port 5173, base path `/frcScoutingApp/`).
Build: `npm run build` (also regenerates `public/tesseract/*` — see below).
Typecheck: `npx tsc --noEmit -p tsconfig.app.json` — **repo is normally at
zero errors**; treat any as real until proven otherwise.

## The two scouting models — this is the single most important thing to understand

The app went through two eras and **both data models are still live**:

1. **Legacy / "counter" model** — `ScoutingData` rows (fuel counts, climb
   level, defense rating), scored by `src/utils/scoring.ts`. This is what the
   season's imported CSV backup (`data/frc-team-stats-2026-08-01.csv`,
   Ventura event) and the old `ScoutingForm` produced. `ScoutingForm.tsx` is
   now **deleted** — nobody can produce new legacy rows anymore, but old ones
   still live in `scouting_records` on the server.

2. **BPS (Blue-Points-per-Second) model** — the new one, built this session
   from a written procedure spec (`Scouting_Procedure.pdf`, adapted from FRC
   team 9483 Overcharge's public methodology). Two independent streams fused
   together:
   - **Stream 1 (human):** `LiveMatch.tsx` — a scout watches ONE robot and
     holds one of four buttons (Shooting/Passing/Contact Defense/Oof) for
     whatever it's doing, producing a timestamped action timeline
     (`TimelineScoutingData`, table `timeline_records`).
   - **Stream 2 (CV):** `src/components/cv/CvTracker.tsx` — reads the
     alliance scores AND the match clock off video footage via OCR
     (tesseract.js), producing a per-second score log (`CvMatchLog`, table
     `cv_logs`).
   - **Fusion + solver:** `src/services/bps/` — `windows.ts` slices each
     match into windows wherever the set of actively-scoring robots changes,
     `solver.ts` fits a weighted-ridge NNLS regression per team (points per
     second), `index.ts` (`runBpsPipeline`) runs four refinement passes:
     prior shrinkage, per-match time-sync, per-phase (auto/teleop) split,
     anomaly cleanup.

**As of the latest change (uncommitted-in-spirit but already committed), the
Scout Workspace shows ONLY BPS data.** The user explicitly asked to stop
seeing legacy/counter-based numbers. `useScoutData.ts` now passes `[]`
instead of the loaded legacy rows into `buildAllTeamMetrics`, so a team with
no fused BPS match shows as "unscouted" — no fallback to old-form or
CSV-imported stats. The legacy rows are still fetched and returned from the
hook (`data.rows`) because `StatsImportControl` still needs them for CSV
export/backup — only the ranking/metrics build stopped consuming them.

A match only produces BPS numbers once it has **both** a timeline (Live
Match) and a CV log (CV Tracker) for it. A timeline with no matching CV log
is simply not counted yet — that's expected behavior, not a bug, if you see
a team with "N matches scouted via Live Match" showing fewer solved matches
in the workspace.

## Session history, roughly chronological

1. **Verified Phase 2 was already built** (picklist/analytics screens, CSV
   import/export, Supabase schema) from a prior session — committed it.
2. **Redesigned every remaining screen** (login, admin panel, match
   selection, scouter management, match schedule, pit scouting) to match the
   "Charging Champions" design system already used by the Scout Workspace,
   following Claude Design mockups. Shared tokens in `src/styles/cc.css`,
   chrome components in `src/components/cc/CCChrome.tsx`. Retired
   `DataAnalysis.tsx` and `SyncControl.tsx` (superseded).
3. **Built the whole BPS system from scratch** per the written procedure
   spec: `LiveMatch.tsx` (replacing `ScoutingForm.tsx`), `CvTracker.tsx` +
   OCR pipeline (`src/services/cv/`), the solver (`src/services/bps/`),
   storage layer (`src/services/bpsStore.ts`), new Supabase tables
   (`supabase/schema-bps.sql`). Validated the solver against synthetic data
   with planted known rates before trusting it on real matches.
4. **Fixed CV OCR against real broadcast footage** — the original region
   model (one quad split 50/50) read essentially nothing from a real FRC
   overlay (scores are separated by the match timer, not adjacent). Rebuilt
   as two independent quads + auto-detection. Also made the digit-count
   guard asymmetric (glyphs merging together after binarizing, e.g. "641"
   losing its blob-count vs character-count match, was wrongly rejecting
   correct reads).
5. **Fixed CV timing** — the sampler was stamping scores with a
   processed-frame counter instead of match time, so OCR compute time was
   leaking into timestamps (offset grew across the match) and capture
   stopped before the real match ended (losing endgame/climbs). Now derives
   match-elapsed time from OCR'ing the clock plate itself, in the same pass
   as the two scores, with phase (auto/teleop) tracked across frames rather
   than inferred from one reading.
6. **Found and fixed a whole chain of event-scoping bugs.** The core lesson,
   repeated four times: **the Supabase tables hold every event any device
   has ever synced, in one table, unfiltered by default.** Every
   query/consumer that doesn't explicitly filter by the current event will
   silently blend events together. Fixed for: `matches` (commit
   `8714717`/`bd12f18`/`6cfe622`), `timeline_records`+`cv_logs` (commit
   `d4815fc`), and finally realized "selected event" itself was pure
   per-device localStorage that only the admin's browser ever set (commit
   `8bda1bb` — added a server-side `is_current` flag on `events` so
   scouters' devices converge on it too). **If you find MORE cross-event
   contamination, this is almost certainly the same bug in a place it
   hasn't been fixed yet.** Grep for `.select('*')` on `matches`,
   `timeline_records`, `cv_logs`, or `scouting_records` in
   `src/services/syncService.ts` / `src/services/bpsStore.ts` /
   `src/services/scoutingRows.ts` and check whether it filters by
   `DataService.getSelectedEvent()`.
7. **Diagnosed a real team's BPS reading as 0 despite scoring well** — three
   compounding bugs (commit `d4815fc`): (a) the time-sync pass was
   overfitting a single-match dataset with only 3-of-6 robots scouted,
   confirmed by hand-solving the exact unconstrained least-squares system
   (not the iterative solver — ruled out a solver bug); (b) event-scoping
   gap #6 above was letting a stray test match satisfy the "enough data"
   gate with irrelevant data; (c) `LiveMatch` could silently save a timeline
   with an EMPTY team key when sent into a match slot the schedule didn't
   fill (two Ventura matches are known to have incomplete alliance arrays),
   producing a numberless ghost row in Field Ranking forever after.
   Fixed all three; `LiveMatch` now refuses to start rather than record
   unattributable data, and `buildAllTeamMetrics` validates every key it
   renders a row for.
8. **CV tracker UX cleanup**: removed the "Load Video" button (URL field now
   submits on Enter; Upload File already self-triggered), made saving to
   the server fully explicit (a Save button — Stop no longer auto-saves,
   giving the operator a chance to review/correct first), and removed a
   hard 60-row display cap on the per-second log (the scrollable container
   was already correctly built — confirmed against real saved data that the
   full match, 159 samples/160s, was always being captured; only the
   display was clipping it).

## Data cleanup already done

Deleted stray test data from earlier verification passes (empty-team-key
timelines from Ventura qm1/qm2, and their associated CV log) — this was my
own leftover test data, not the user's. Already gone from the server.

## Supabase migrations — all three must be run, in order

1. `supabase/schema.sql` — base tables (events, matches, scouting_records,
   scouters, pit_data, admins) + `pit-images` storage bucket. **Run.**
2. `supabase/schema-bps.sql` — adds `timeline_records`, `cv_logs`. **Run.**
3. `supabase/schema-current-event.sql` — adds `is_current` boolean to
   `events` (+ a partial unique index so only one event can be current at a
   time). **Run — user confirmed this in the current session.**

All three are purely additive (no drops/alters of existing data) and every
consuming code path degrades gracefully if a migration hasn't landed yet
(treats missing data as "none" rather than erroring).

RLS on every table is anon-permissive (`using (true) with check (true)`) —
the app ships a publishable key in its bundle, so this is intentional and
documented in the schema files, not an oversight.

**Current server state** (last checked): `2026cagle` (Glendale) is marked
`is_current = true`. `2026caven` (Ventura) holds the old imported CSV season
data, `is_current = false`.

## Tesseract / OCR asset handling

`public/tesseract/*` (worker + WASM cores) are **gitignored** and regenerated
by `npm run tesseract:sync` (wired into both `build` and `postinstall`) —
`scripts/copy-tesseract.mjs` copies them out of `node_modules`.
`eng.traineddata.gz` (the language data, not on npm) **is committed** — if
it's ever missing, the build script fails loudly with a curl command to
restore it from `tessdata.projectnaptha.com`, rather than silently shipping
a broken OCR worker.

## Known non-bugs / things that look wrong but aren't

- **A team's BPS number seeming too low relative to how well they seemed to
  perform** can be a genuine, expected effect of thin data (few matches
  solved, not all 6 robots on the field scouted) rather than a bug — the
  solver fits ONE constant points-per-second rate per robot across the
  whole match, which underfits bursty scorers when there's not enough data
  to disentangle simultaneous scorers. Verified this specific case by hand
  (commit `d4815fc`'s investigation): a team's windows where it was the
  *sole* flagged scorer summed to notably more points than the fitted rate
  implied — a real signal of underfit, not a computation bug. This gets
  better with more matches and fuller-field scouting. **If asked to
  "fix" a suspiciously-low number again, verify with the same
  approach — solo-scorer windows are a hard lower bound, computable
  directly from `buildWindows()` output — before assuming a bug.**
- A timeline with no matching CV log is *supposed* to not count toward BPS
  yet (see the two-streams explanation above).
- 12 of Ventura's matches (`qm1`–`qm12`) have genuinely empty
  `alliances.{red,blue}.team_keys` arrays in the stored schedule data — a
  pre-existing TBA-import data-quality issue, not something introduced this
  session. `LiveMatch` now guards against it (refuses to start rather than
  recording unattributable data) but the underlying schedule gap for those
  12 matches hasn't been re-imported/fixed.

## Suggested next steps

- Scout more matches with BOTH streams (Live Match + CV Tracker) to give the
  solver more data — most remaining oddities are data-sparsity effects, not
  bugs, and get better automatically as more matches are solved.
- If cross-event contamination shows up anywhere else, check whether that
  code path filters by `DataService.getSelectedEvent()` — see point 6 above.
- Consider re-importing Ventura's `qm1`–`qm12` schedule to fix the empty
  `team_keys` data-quality gap, if that event is ever scouted again.
- The Scout Workspace's "expected" `bpsReport.diagnostics` (matches solved,
  window count, orphan score, dropped windows, time shifts) is surfaced on
  the Team Analysis screen — worth checking there for solver health as more
  data comes in, especially `orphanScore` (score that moved with nobody
  flagged as scoring — high orphan score means scouts are missing events).
