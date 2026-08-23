# Match capture worker

Unattended scoreboard reading for match day. Runs on the workshop PC; the
scouting lead supervises over AnyDesk.

Status: **M3 complete** — a single match window can be processed end to end
from a local file. Scanning a multi-match VOD (M4), match identification (M5)
and the Supabase writer + dashboard (M6) are not built yet.

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

```bash
node worker/src/process.mjs <video> --t0 <seconds> [--match qm1] [--out log.json]
```

`--t0` is the green flag in video time, and only has to be roughly right: it
brackets the window, and `MatchClock` derives the true match start from the
on-screen timer. For a single-match clip `--t0 0` works.

Output is a `CvMatchLog` — the same shape `parseCvJson` already imports — plus
`quality` diagnostics and `rawReads`.

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
npm run worker:check     # the CV core still compiles with no DOM at all
npm run worker:golden    # Node reproduces the browser's readings
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

~30s of wall time per match against a ~7 minute match cadence is roughly 14x
headroom, on 8 OCR workers.
