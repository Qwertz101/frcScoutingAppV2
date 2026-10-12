# SoCal Showdown local capture

Verified October 10, 2026 on the official Saturday broadcast:
https://www.youtube.com/watch?v=uyGS9UNrbTY
Event source: https://www.socal-showdown.com/watch
TBA event key: `2026cass` (FIRST uses `CAEL`).

## Run

Requires Node 20+, ffmpeg, ffprobe and yt-dlp on PATH.

```sh
npm ci
npm run worker:build
npm run build
npm run worker:serve -- --event 2026cass
```

Open http://127.0.0.1:7654 for the capture dashboard or
http://127.0.0.1:7654/app for the scouting app. Paste the stream URL and choose
**live**, then Start. The app's CV tab can also start/cancel the same worker.
Leave database writing disabled. Completed captures are saved automatically to
`worker/logs/*.json` and can be downloaded from the dashboard, including after a
restart. This directory is gitignored. Only derived observations are saved.

For capture directly from the terminal: `npm run worker:socal` (Ctrl-C stops).
If the stream has ended, choose **recording** instead; the live source refuses
to treat an archive as an advancing broadcast.

The supplied credential is in `.env.local` with owner-only permissions, under
`SUPABASE_ANON_KEY`, deliberately without the `VITE_` prefix so it does not enter
browser bundles. No Supabase project URL is configured, per the user's request.
Local capture works without Supabase or TBA credentials. Without `TBA_API_KEY`,
match keys remain blank: review and assign a real match key before importing
into the scouting app. Do not infer identity from capture order.

## Changes

- Reuse the shared Tesseract OCR engine, score gate, MatchClock, worker pool,
  and existing live monitor. SoCal's measured score/timer boxes exclude the
  side fuel counters, work at 1080p and 720p, and identify red on the left.
- YouTube HLS is decoded directly with original presentation timestamps. OCR
  latency and bursty network delivery no longer change the frame's timestamp.
  Sampling selects actual frames instead of duplicating frames across gaps.
- Samples preserve `videoSec` and per-side acceptance flags; logs preserve the
  source URL and green-flag position. The JSON importer retains these fields.
- Window readers borrow the live iterator instead of closing it after one
  match. Fractional timestamps survive preroll. Team-ID snapshots are retained
  separately from the short ring buffer until identification finishes.
- Reject incomplete/cancelled/gapped windows; retry source failures with bounded
  exponential backoff. Probe and network reads have timeouts; cancellation
  interrupts decoding and backoff. Refresh signed stream URLs on reconnect.
- Score resync requires consecutive confident reads. Invalid numeric values
  cannot become scores. Pregame totals cannot poison the next match's gates.
  Phase resets and end-of-match require corroboration from distinct frames.
  Unreadable held scores do not count as a settled final score.
- Save local JSON before attempting optional database writes. A write failure
  does not stop capture. Modern Supabase publishable keys are API keys, not
  JWT bearer tokens. The local dashboard no longer misreports an absent
  database as an unmigrated database.

## Verification

`npm run test:cv` runs deterministic regression tests plus real scoreboard
fixture OCR (ffmpeg required). `npm run test:merge`, `npm run worker:check`,
`npx tsc --noEmit -p tsconfig.app.json`, and `npm run build` also pass.

A complete Qualification 12 capture was validated against the running stream
and repeated through its DVR using the final timestamp path. Both yielded
161 match-time samples, blue 349 / red 407 at the final displayed scoreboard,
98.2% coverage, no score-gate resyncs and no fallback clock. The green flag was
at media time 14139.533333 (approximately 3:55:39.5).
At media time 14201 the overlay read blue 188, red 147, clock 1:41;
at player position 14204 the YouTube replay showed blue 188, red 165, clock
1:38. The replay and extracted timeline agree within the 1-second sampling
resolution. Final values are observed scoreboard totals, not an official TBA
result reconciliation.

Repository-wide lint reports 395 errors and 70 warnings on both the pristine
checkout and the modified checkout. These pre-existing lint failures are not
addressed here. Build also reports existing large-chunk/Browserslist warnings.

## Limits

- Capture is 1 Hz, not a record of each individual scoring action. Clock locking
  requires two observations, so the earliest seconds can be absent. Official
  corrections can arrive after the displayed score settles.
- The score gate retains the existing nondecreasing-score assumption. Downward
  official corrections require review; a scoreboard total is not per-robot
  scoring attribution.
- The fixed SoCal geometry is verified for this broadcast. A moved/replaced
  overlay requires recalibration. Replay inserts, ambiguous late-match starts,
  or broadcast timestamp resets need operator review.
- A reconnect crossing a match rejects that match instead of filling gaps with
  invented scores. Reconnection cannot recover footage missing from capture.
- No database synchronization or automatic TBA match naming was tested; neither
  is configured. Local unidentified logs are retained for manual assignment.
- Original media PTS was verified against this YouTube stream's replay player;
  an encoder restart or another broadcaster can require new alignment checks.
