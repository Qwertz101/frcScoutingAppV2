/**
 * One recording, start to finish — as a function rather than a script.
 *
 * This is the body that used to live inside `main.mjs`. It moved here so the
 * CLI and the job server (`server.mjs`, which is what the app's CV tab talks
 * to) run *literally the same code* rather than two copies that drift. The CLI
 * is now a thin argument parser over this; the server is a thin HTTP wrapper
 * over it. Anything either one needs to show a human goes out through the
 * `log`/`onRow` callbacks instead of straight to stderr, because a browser tab
 * cannot read stderr.
 *
 * **Dry by default, here as well as in the CLI.** `write` has to be passed
 * explicitly. `match_key` is a primary key and an upsert replaces whatever is
 * already there, so the flag exists to make sure nobody discovers that by
 * accident — including through a web form, where it is even easier to click
 * something without meaning it.
 */

import { scan } from './scan.mjs';
import { scanStrided } from './stride.mjs';
import { processMatch } from './process.mjs';
import { identify } from './identify.mjs';
import { scoreQuality } from './quality.mjs';
import { fetchQualSchedule } from './tba.mjs';
import { backfillSettle } from './settle.mjs';
import { upsertCvLog, checkSchema } from './supabase.mjs';
import { probe } from './ffmpeg.mjs';
import { createPool, defaultWorkers } from './ocr.mjs';
import { isRemoteSource, resolveVodUrl, downloadVod } from './sources.mjs';
import { resolveLayout } from './layouts.mjs';
import { FRC_BROADCAST } from './core.mjs';
import {
  fetchCalibratedLayout,
  quadsFromLayout,
  teamQuadsFromLayout,
  validateLayout,
} from './calibrated.mjs';

/**
 * Scan a recording for matches, read each one, and optionally write them.
 *
 * `source` is a local path or a YouTube VOD page URL — `resolveVodUrl` turns
 * the latter into a direct seekable CDN URL and everything downstream treats
 * it exactly like a file, because ffmpeg does.
 *
 * Returns `{ rows, matches, flagged, unidentified, seconds }`.
 */
export async function runVod(source, opts = {}) {
  const log = opts.log ?? (() => {});
  const onRow = opts.onRow ?? (() => {});
  const eventKey = opts.eventKey ?? '';
  const write = Boolean(opts.write);
  const force = Boolean(opts.force);
  const layout = opts.layout ?? resolveLayout(eventKey, opts.layoutName ?? null) ?? FRC_BROADCAST;

  // The resolved googlevideo URL is a kilobyte-long signed query string — fine
  // for ffmpeg, useless as a label. Every place this run identifies its source
  // to a human uses `sourceLabel`, never the resolved input.
  const sourceLabel = source;
  let input = source;
  let cleanupDownload = null;
  // Seconds between the start of `input` and the start of the original
  // recording. Non-zero only when a bounded window was downloaded, where the
  // local file begins partway into the VOD; every greenFlagAt reported outward
  // adds it back so a later reprocess seeks the right place in the real source.
  let sourceOffset = 0;
  // Whether the scan still needs to bound itself. A downloaded window is
  // already exactly the window, so bounding it again would cut into it.
  let scanStart = opts.start != null ? Number(opts.start) : undefined;
  let scanDuration = opts.duration != null ? Number(opts.duration) : undefined;

  if (isRemoteSource(input)) {
    if (opts.download) {
      const dl = await downloadVod(input, {
        start: scanStart,
        duration: scanDuration,
        keep: Boolean(opts.keepDownload),
        signal: opts.signal,
        log,
        onProgress: opts.onProgress,
      });
      input = dl.path;
      // A kept download's cleanup is a no-op, so this stays unconditional --
      // the decision lives in one place (downloadVod) rather than being
      // re-derived here.
      cleanupDownload = dl.cleanup;
      sourceOffset = dl.offset;
      scanStart = undefined;
      scanDuration = undefined;
    } else {
      log('resolving direct URL for ' + input + ' …');
      input = await resolveVodUrl(input);
      log('resolved');
    }
  }

  const schema = await checkSchema().catch(() => ({ ok: false, message: 'Supabase unreachable' }));
  if (write && !schema.ok) log('cannot write: ' + schema.message + ' — continuing as a dry run');
  opts.onSchema?.(schema);

  const schedule = eventKey ? await fetchQualSchedule(eventKey) : null;
  if (eventKey && !schedule) log('warning: ' + eventKey + ' not on TBA — matches cannot be identified');
  else if (schedule) log(eventKey + ': ' + schedule.length + ' qual matches on TBA');

  // A layout a human taught for this event replaces the whole detection step.
  // See calibrated.mjs: this is the path that makes an unfamiliar or distorted
  // scoreboard workable, and detection stays as the fallback when there is none.
  let fixedQuads = null;
  let teamQuads = null;
  const calibrated = opts.calibrated ?? (await fetchCalibratedLayout(eventKey));
  if (calibrated) {
    const problem = validateLayout(calibrated);
    if (problem) {
      log('calibrated layout for ' + eventKey + ' is unusable (' + problem + ') — falling back to detection');
    } else {
      fixedQuads = quadsFromLayout(calibrated);
      teamQuads = teamQuadsFromLayout(calibrated);
      log(
        'using the calibrated layout for ' + eventKey +
          (calibrated.label ? ' (' + calibrated.label + ')' : '') +
          (teamQuads ? ' with team boxes' : ' — no team boxes, identification will infer them')
      );
    }
  } else if (eventKey) {
    log('no calibrated layout for ' + eventKey + ' — detecting the scoreboard from the video');
  }

  const meta = opts.meta ?? (await probe(input));
  log(sourceLabel + '  ' + meta.width + 'x' + meta.height + '  ' + (meta.duration / 60).toFixed(1) + ' min');

  const pool = opts.pool ?? (await createPool(opts.workers ?? defaultWorkers()));
  const ownPool = !opts.pool;
  const began = Date.now();
  const rows = [];
  let unidentified = 0;
  /** Best quality seen per match key, so a duplicate cannot overwrite a better read. */
  const bestByKey = new Map();

  try {
    log('scanning for match starts…');
    const scanOpts = {
      pool,
      meta,
      layout,
      start: scanStart,
      duration: scanDuration,
      fixedQuads,
      signal: opts.signal,
      // Reported against the window actually being scanned, not the whole
      // recording. `--start 3600 --duration 900` on a nine-hour VOD is 100% of
      // the work asked for and 3% of the file; showing the latter makes a
      // nearly-finished scan look barely begun.
      onProgress: (at, total) => {
        const from = scanStart ?? 0;
        const to = scanDuration != null ? from + scanDuration : total;
        opts.onProgress?.({ phase: 'scan', at, from, to, total });
      },
      log,
    };

    // Seek to a few hundred places rather than decoding the whole recording,
    // when there is a taught layout to read the clock through. Tier A's
    // `fps=0.5` still decodes every frame and only discards most of them --
    // measured at ~7.4x realtime, so about 72 minutes for a nine-hour event
    // before any OCR. See stride.mjs. Detection-based scanning keeps the old
    // path, because a stride probe has no quads to read a clock with and
    // deriving them per probe would cost more than the decode it saves.
    let found = null;
    if (fixedQuads && opts.strided !== false) {
      found = await scanStrided(input, scanOpts);
      if (found && !found.length) {
        log('stride scan found nothing — falling back to the full decode');
        found = null;
      }
    }
    if (!found) found = await scan(input, scanOpts);

    log(found.length + ' match(es) found');

    for (let i = 0; i < found.length; i++) {
      if (opts.signal?.aborted) {
        log('cancelled');
        break;
      }
      const f = found[i];
      const tag = '[' + (i + 1) + '/' + found.length + '] t0=' + f.greenFlagAt;

      log(tag + ' processing…');
      // One unreadable candidate must not take the run down with it. The
      // scanner deliberately offers low-confidence starts (`method: 'run'`,
      // sometimes with no quads at all), and `processMatch` quite reasonably
      // throws when it cannot find the scoreboard -- so the whole event's
      // remaining matches used to be lost to a single bad candidate.
      let out;
      try {
        out = await processMatch(input, f.greenFlagAt, {
          pool,
          meta,
          quads: fixedQuads ?? f.quads,
          layout,
          eventKey,
          sourceLabel: isRemoteSource(sourceLabel) ? sourceLabel : sourceLabel.split(/[\\/]/).pop(),
        });
      } catch (e) {
        log(tag + ' skipped: ' + (e.message ?? e));
        rows.push({
          match_key: '',
          event_key: eventKey,
          source: 'auto-worker',
          quality: { score: 0, reasons: ['could not be read: ' + (e.message ?? e)], flagged: true },
          flagged: true,
          final: null,
          greenFlagAt: sourceOffset + f.greenFlagAt,
          write: 'skipped',
          updated_at: new Date().toISOString(),
        });
        unidentified++;
        onRow(rows[rows.length - 1], null);
        continue;
      }

      let ident = null;
      if (schedule) {
        log(tag + ' identifying…');
        ident = await identify(input, f.greenFlagAt, schedule, {
          pool, meta, quads: fixedQuads ?? f.quads, teamQuads, layout,
        });
        if (ident.matchKey) out.log.matchKey = ident.matchKey;
      }

      // Give back the points that landed after the scoreboard froze. Only ever
      // upward, only ever small, and only for an identified match -- see
      // settle.mjs. Runs BEFORE quality is scored so the score describes the
      // log that is actually written.
      if (out.log.matchKey && schedule) {
        const sched = schedule.find((m) => m.matchKey === out.log.matchKey);
        const fill = backfillSettle(out.log, sched?.blueScore, sched?.redScore);
        if (fill.applied) {
          log(
            '    settled: added ' + fill.blue + '/' + fill.red +
              ' point(s) that landed after the buzzer'
          );
        } else if (fill.overread || fill.tooLarge) {
          log('    ! ' + fill.reason);
        }
      }

      const q = scoreQuality(out.log, out.diagnostics, ident);
      out.log.quality = q;
      out.log.flagged = q.flagged;
      out.log.rawReads = out.rawReads;

      const last = out.log.samples[out.log.samples.length - 1];
      const row = {
        match_key: out.log.matchKey || '',
        event_key: eventKey,
        source: out.log.source,
        quality: q,
        flagged: q.flagged,
        final: last ? { blue: last.blue, red: last.red } : null,
        // Kept so the dashboard's Reprocess button has something to reprocess
        // *from*: without the green flag there is no way to re-read one match
        // without rescanning the whole recording.
        // In the ORIGINAL recording's timeline, not the local file's -- a
        // downloaded window starts partway in, and a reprocess later works
        // from the URL.
        greenFlagAt: sourceOffset + f.greenFlagAt,
        updated_at: new Date().toISOString(),
      };

      if (!out.log.matchKey) unidentified++;

      // One real match can be detected twice -- a partial lock near its start
      // and the true green flag a little later both look like starts, and both
      // identify to the same teams. Measured on IRI qm55: t0=552 read 313-94
      // over 77 of 164 seconds, t0=702 read 567-259 against TBA's 567-262.
      //
      // Both upsert the same primary key, so without this the LAST one written
      // wins on ordering alone -- and a partial read landing after a good one
      // silently destroys it. Keeping the higher-quality read makes that a
      // decision rather than a coincidence.
      const prior = out.log.matchKey ? bestByKey.get(out.log.matchKey) : undefined;
      const supersededByPrior = prior != null && prior.score >= q.score;

      if (supersededByPrior) {
        row.write = 'skipped — duplicate of a better read';
        row.quality = {
          ...q,
          reasons: [...q.reasons, 'another detection of this match scored higher (q=' + prior.score.toFixed(2) + ')'],
        };
      } else if (write && schema.ok) {
        const res = await upsertCvLog(out.log, { force });
        row.write = res.written ? (res.replaced ? 'replaced' : 'written') : 'refused';
        if (!res.written) {
          row.quality = { ...q, reasons: [...q.reasons, res.reason] };
          row.flagged = true;
          log('    ! ' + res.reason);
        }
      } else {
        row.write = 'dry run';
      }

      if (out.log.matchKey && !supersededByPrior) bestByKey.set(out.log.matchKey, { score: q.score });

      rows.push(row);
      onRow(row, out.log);

      log(
        '    ' + (out.log.matchKey || 'UNIDENTIFIED').padEnd(16) +
          (last ? last.blue + '-' + last.red : 'n/a').padEnd(10) +
          'q=' + q.score.toFixed(2) + (q.flagged ? ' FLAGGED' : '') + '  ' + row.write
      );
      // After the summary line, so the note reads as belonging to the match it
      // is about rather than to the one printed above it.
      if (prior != null) {
        log(
          supersededByPrior
            ? '      - kept the earlier read of this match instead (q=' + prior.score.toFixed(2) + ')'
            : '      - supersedes an earlier, lower-quality read (q=' + prior.score.toFixed(2) + ')'
        );
      }
      for (const r of q.reasons) log('      - ' + r);
    }
  } finally {
    if (ownPool) await pool.terminate();
    // Non-negotiable: the temp file must not outlive the job that made it.
    // See downloadVod on why storing footage at all is a deliberate, bounded
    // exception rather than a change of policy.
    if (cleanupDownload) {
      await cleanupDownload();
      if (!opts.keepDownload) log('temporary download deleted');
    }
  }

  const seconds = (Date.now() - began) / 1000;
  const flagged = rows.filter((r) => r.flagged).length;
  log(
    rows.length + ' match(es) in ' + (seconds / 60).toFixed(1) + ' min · ' +
      flagged + ' flagged · ' + unidentified + ' unidentified'
  );
  if (!write) log('dry run — nothing was written.');

  return { rows, matches: rows.length, flagged, unidentified, seconds };
}

/**
 * Re-read a single match whose green flag is already known.
 *
 * This is what the dashboard's Reprocess button runs. It deliberately skips
 * the scan — the expensive part — because the only reason to reprocess is that
 * the *reading* of a match went wrong, not the finding of it.
 */
export async function reprocessOne(source, greenFlagAt, opts = {}) {
  const log = opts.log ?? (() => {});
  const eventKey = opts.eventKey ?? '';
  const layout = opts.layout ?? resolveLayout(eventKey, opts.layoutName ?? null) ?? FRC_BROADCAST;

  let input = source;
  if (isRemoteSource(input)) input = await resolveVodUrl(input);

  const meta = opts.meta ?? (await probe(input));
  const pool = opts.pool ?? (await createPool(opts.workers ?? defaultWorkers()));
  const ownPool = !opts.pool;

  try {
    log('reprocessing t0=' + greenFlagAt + ' …');
    const out = await processMatch(input, greenFlagAt, {
      pool, meta, layout, eventKey,
      sourceLabel: isRemoteSource(source) ? source : source.split(/[\\/]/).pop(),
    });

    let ident = null;
    const schedule = eventKey ? await fetchQualSchedule(eventKey) : null;
    if (schedule) {
      ident = await identify(input, greenFlagAt, schedule, { pool, meta, layout });
      if (ident.matchKey) out.log.matchKey = ident.matchKey;
    }
    // A reprocess that was asked for by match key keeps that key even if
    // identification abstains this time: the human already told us what it is.
    if (opts.matchKey) out.log.matchKey = opts.matchKey;

    const q = scoreQuality(out.log, out.diagnostics, ident);
    out.log.quality = q;
    out.log.flagged = q.flagged;
    out.log.rawReads = out.rawReads;

    let write = { written: false, reason: 'dry run' };
    if (opts.write) write = await upsertCvLog(out.log, { force: Boolean(opts.force) });

    const last = out.log.samples[out.log.samples.length - 1];
    log(
      (out.log.matchKey || 'UNIDENTIFIED') + '  ' +
        (last ? last.blue + '-' + last.red : 'n/a') + '  q=' + q.score.toFixed(2) +
        (write.written ? '  written' : '  ' + write.reason)
    );

    return { log: out.log, quality: q, write };
  } finally {
    if (ownPool) await pool.terminate();
  }
}
