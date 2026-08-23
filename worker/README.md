# Match capture worker

Unattended scoreboard reading for match day. Runs on the workshop PC; the
scouting lead supervises over AnyDesk.

Status: **M5 complete** — a multi-match recording can be scanned for match
starts, each match processed end to end, and the match it belongs to identified
from the team numbers on screen. The Supabase writer and dashboard (M6) are not
built yet, so nothing is written anywhere: the worker prints logs and that is
all.

## No video is ever stored

This pipeline decodes streams in flight and persists **only derived numbers**.
There is no clip archive, no download step, and no cache of footage. "Clip"
in this codebase means *a time window*, never a file.

Please do not add clip archiving as a convenience later. Nothing here needs it:
the raw per-second OCR observations are persisted alongside the gated samples,
which is what makes the likely class of future bug — gate thresholds, clock
logic, resync rules — re-processable without the video. Keeping footage would
add storage, retention questions and platform terms-of-service exposure in
exchange for a capability that is already covered.

## Setup

```bash
winget install Gyan.FFmpeg yt-dlp.yt-dlp
npm run worker:build
```

`worker:build` compiles `src/services/cv` into `worker/gen` as CommonJS.
**Re-run it after any change under `src/services/cv`** — the worker runs the
compiled copy, not the TypeScript sources.

ffmpeg is located by trying `$FFMPEG_PATH`, then winget's per-user install
directory, then `PATH`. The winget lookup matters because winget edits the user
PATH and an already-running shell never sees it.

## Use

Find the matches in a recording:

```bash
node worker/src/scan.mjs <video>
```

Process one of them:

```bash
node worker/src/process.mjs <video> --t0 <seconds> [--match qm1] [--out log.json]
```

`--t0` is the green flag in video time, and only has to be roughly right: it
brackets the window, and `MatchClock` derives the true match start from the
on-screen timer. For a single-match clip `--t0 0` works.

Output is a `CvMatchLog` — the same shape `parseCvJson` already imports — plus
`quality` diagnostics and `rawReads`.

## Scanning

Finding matches is split in two, because tesseract costs ~1s a call and a
six-hour event VOD is 21,600 seconds — OCR-ing every second to look for a
countdown would take longer than the event did.

**Tier A** is colour only, no OCR. At 640 wide, sampled every two seconds,
`detectScoreRegions` costs ~3ms a frame. It says only *the overlay is on
screen*, which is enough to reduce six hours to a handful of candidate runs.

**Tier B** OCRs the timer and nothing else — both score plates are skipped,
removing two thirds of the cost per sample. A coarse pass every five seconds
looks for a *fresh* clock (near 0:20, or near 2:20 for the post-AUTO reset) to
bracket the start, then a fine pass at 1fps feeds a real `MatchClock` until it
locks and reports its green flag. About 40 recognize calls per match.

Two things that look like details and are not:

**One run is not one match.** Broadcasts leave the scoreboard up between
matches, so all of an event can arrive as a single continuous run. The scanner
walks each run taking matches until no more fresh clocks appear. Tested: on a
VOD whose filler is a frozen end-of-match scoreboard, Tier A yields exactly one
run spanning everything, and all five matches are still recovered.

**Quads are re-derived when a search comes up empty**, not once per run and not
once per window. Deriving per window costs seven seeks a match to compute the
same answer every time; deriving once per run breaks the moment the overlay
moves. Caching with refresh-on-failure gets both.

A run that never locks a clock only produces a guessed start if it is short
enough to be a single match. A ten-minute overlay hold produces nothing, because
a start invented there would be identified as some real match and written over
it.

## Identifying the match

`cv_logs.match_key` is the primary key and the writer upserts on it, so a wrong
answer here does not add a bad row — it *destroys a good one*. Everything about
this module follows from that: it abstains readily, and an acceptance needs a
*margin* over the runner-up rather than merely being the best of a bad set.

The signal is the team numbers printed on the alliance plates, matched as a set
against the event's qualification schedule. A set is the right shape because the
OCR's failure mode is dropping a number, not inventing a plausible one, and six
teams appear together in exactly one qual match. Matching is side-aware — a
number seen on the blue plate only counts towards that match's blue alliance —
which is what produces the margin, since near-repeat alliances are common but
near-repeats on the *same sides* are not.

Finding the numbers needs the plate's full extent, which is not what
`detectScoreRegions` reports: that stops at the first non-plate colour, which on
a broadcast overlay is the nearest team logo. `plateExtent` walks outwards from
the score instead, stepping over the logo islands, capped at four score-widths
because a venue with alliance-coloured walls otherwise never stops. Then the
band is split into separate numbers by the gaps between glyphs, and each is read
with the same digit-count guard the scores use, so a dropped digit abstains
instead of becoming a different, entirely plausible team.

Two things measured rather than assumed:

**Team numbers are not all four digits.** 2026cagle fields team 22 and team 4.
Restricting to three-to-five digit groups made two teams permanently invisible
and silently capped identification at 5 of 6.

**One preparation variant is not enough.** One clip's overlay over-inks badly
enough at the default Sauvola k that all three of its numbers merge into single
blobs. All three `PREP_VARIANTS` are tried and the results voted, exactly as the
score reader does.

## Design

Two things differ from the browser tracker, and only two:

**Frames arrive by sequential decode, not by seeking.** A `<video>` element
offers no way to get at an arbitrary frame except to seek to it; ffmpeg does.
One long decode is far faster than N seeks and gives strictly better
timestamps — frame *n* is exactly at `t0 + n/fps`, whereas a browser seek lands
within a few frames of where it was asked. That difference is measured, not
assumed: see the header of `tools/golden-node.mjs`.

**OCR runs in parallel; the gate and the clock run strictly in order.** Per
frame recognition is independent, so it fans out across a worker pool. But
`ScoreGate` and `MatchClock` are stateful and order-dependent — feeding them out
of order would make the gate reject good scores as backwards jumps, and the
damage would look exactly like bad OCR rather than like a scheduling bug. So the
pool returns raw reads *in input order* and the stateful pass is a plain
sequential loop.

Everything else — rectification, thresholding, digit segmentation, the 2-of-3
vote, the gate, the clock — is the identical code the app ships, imported from
the compiled core rather than reimplemented. A recognition fix for the operator
is a recognition fix for the worker in the same commit.

## Checks

```bash
npm run worker:check       # the CV core still compiles with no DOM at all
npm run worker:golden      # Node reproduces the browser's readings
npm run worker:vod         # build the synthetic multi-match VOD (--hold variant too)
npm run worker:check-scan  # score the scanner against it
npm run worker:check-identify    # name each clip's match, using only the pixels
npm run worker:check-thresholds  # can any partial read resolve to the WRONG match?
```

`worker:check` runs in CI. It type-checks `src/services/cv` against
`lib: ["ES2020"]` with no DOM library, so a stray `document` or `ImageData`
fails the build rather than the competition.

## Measured

Five single-match clips from Glendale, processed unattended with no operator
input and no hand-placed regions:

| clip | rows | final | clock | coverage | wall |
|---|---|---|---|---|---|
| Einstein1 | 161 | 641–420 | 167/174 | 98% | 28s |
| Qual2 | 160 | 300–240 | 169/172 | 98% | 27s |
| Qual3 | 161 | 42–95 | 173/179 | 98% | 31s |
| Qual6 | 160 | 153–15 | 168/170 | 98% | 31s |
| Qual9 | 160 | 260–269 | 168/174 | 98% | 38s |

All five are monotonic with zero negative deltas and exactly 20 auto rows.
Einstein1's 641–420 is the known-correct on-screen final for `2026cmptx_sf1m1`.

Scanning, on a 20-minute synthetic VOD built from those same five clips at
1280x720 — less than half their native width — with 75s between matches:

| filler between matches | runs found | matches | worst error | spurious |
|---|---|---|---|---|
| scoreboard-free arena footage | 5 | **5/5** | 0.72s | 0 |
| frozen end-of-match scoreboard | 1 | **5/5** | 0.72s | 0 |

Both variants give identical starts, which is the point: the multi-match-per-run
path and the one-match-per-run path agree. Ground truth is not hand-labelled —
each clip is scanned standalone and its green flag added to the offset the VOD
was built at.

Processing each match at the scanner's own timestamps reproduces all five finals
exactly, at 720p, with no operator input anywhere in the chain.

Identification, against the real 2026cagle schedule from TBA — the clips are
named after the quals they are, but nothing in the pipeline is told the name,
and it has to land on the right key out of 74:

| clip | read | result |
|---|---|---|
| Qual2 | blue 9505 8033 3255 · red 6934 696 2659 | qm2, 6/6, runner-up 2 |
| Qual3 | almost nothing | **abstains** |
| Qual6 | blue 3512 6560 2404 · red 22 | qm6, 4/6, runner-up 2 |
| Qual9 | blue 6934 3255 9772 · red 3965 7415 9696 | qm9, 6/6, runner-up 2 |

**3 correct, 1 abstained, 0 wrong.**

Four clips is not a sample you can set a threshold from, but the risk being
managed is a property of the *schedule*, which is fully known. Enumerating every
subset of every match — the realistic degradation, since the OCR drops numbers
rather than inventing them — gives:

| teams read | correct | abstain | wrong |
|---|---|---|---|
| 2 of 6 | 0 | 1110 | **0** |
| 3 of 6 | 0 | 1480 | **0** |
| 4 of 6 | 1110 | 0 | **0** |
| 5 of 6 | 444 | 0 | **0** |
| 6 of 6 | 74 | 0 | **0** |

The thresholds sit exactly on the cliff: at four teams identification is always
correct, below four it always abstains, and **no dropped read can reach a wrong
match key**. The caveat this does not cover is an *invented* number that happens
to belong to another match; the vote counts are what guard that, and they are
not close (confident numbers score 10–15 across the sampled frames, fragments
score 1–4).

### Not built

The plan's `teams+time` and `sequence` fallbacks are deliberately not
implemented. Both need a wall-clock mapping from video time, which does not
exist until live capture (M7), so neither could be tested — and `sequence` in
particular is the one link in the chain that guesses. Given that four teams is
enough to be certain and abstaining costs only a dashboard row, they buy little
and risk the thing this module exists to prevent. Unidentified matches surface
for a human to assign.

~30s of wall time per match against a ~7 minute match cadence is roughly 14x
headroom, on 8 OCR workers.
