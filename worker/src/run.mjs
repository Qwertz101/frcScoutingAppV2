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
import { processMatch } from './process.mjs';
import { identify } from './identify.mjs';
import { scoreQuality } from './quality.mjs';
import { fetchQualSchedule } from './tba.mjs';
import { upsertCvLog, checkSchema } from './supabase.mjs';
import { probe } from './ffmpeg.mjs';
import { createPool, defaultWorkers } from './ocr.mjs';
import { isRemoteSource, resolveVodUrl } from './sources.mjs';
import { resolveLayout } from './layouts.mjs';
import { FRC_BROADCAST } from './core.mjs';

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
  if (isRemoteSource(input)) {
    log('resolving direct URL for ' + input + ' …');
    input = await resolveVodUrl(input);
    log('resolved');
  }

  const schema = await checkSchema().catch(() => ({ ok: false, message: 'Supabase unreachable' }));
  if (write && !schema.ok) log('cannot write: ' + schema.message + ' — continuing as a dry run');
  opts.onSchema?.(schema);

  const schedule = eventKey ? await fetchQualSchedule(eventKey) : null;
  if (eventKey && !schedule) log('warning: ' + eventKey + ' not on TBA — matches cannot be identified');
  else if (schedule) log(eventKey + ': ' + schedule.length + ' qual matches on TBA');

  const meta = opts.meta ?? (await probe(input));
  log(sourceLabel + '  ' + meta.width + 'x' + meta.height + '  ' + (meta.duration / 60).toFixed(1) + ' min');

  const pool = opts.pool ?? (await createPool(opts.workers ?? defaultWorkers()));
  const ownPool = !opts.pool;
  const began = Date.now();
  const rows = [];
  let unidentified = 0;

  try {
    log('scanning for match starts…');
    const found = await scan(input, {
      pool,
      meta,
      layout,
      start: opts.start != null ? Number(opts.start) : undefined,
      duration: opts.duration != null ? Number(opts.duration) : undefined,
      signal: opts.signal,
      // Reported against the window actually being scanned, not the whole
      // recording. `--start 3600 --duration 900` on a nine-hour VOD is 100% of
      // the work asked for and 3% of the file; showing the latter makes a
      // nearly-finished scan look barely begun.
      onProgress: (at, total) => {
        const from = opts.start != null ? Number(opts.start) : 0;
        const to = opts.duration != null ? from + Number(opts.duration) : total;
        opts.onProgress?.({ phase: 'scan', at, from, to, total });
      },
      log,
    });
    log(found.length + ' match(es) found');

    for (let i = 0; i < found.length; i++) {
      if (opts.signal?.aborted) {
        log('cancelled');
        break;
      }
      const f = found[i];
      const tag = '[' + (i + 1) + '/' + found.length + '] t0=' + f.greenFlagAt;

      log(tag + ' processing…');
      const out = await processMatch(input, f.greenFlagAt, {
        pool,
        meta,
        quads: f.quads,
        layout,
        eventKey,
        sourceLabel: isRemoteSource(sourceLabel) ? sourceLabel : sourceLabel.split(/[\\/]/).pop(),
      });

      let ident = null;
      if (schedule) {
        log(tag + ' identifying…');
        ident = await identify(input, f.greenFlagAt, schedule, {
          pool, meta, quads: f.quads, layout,
        });
        if (ident.matchKey) out.log.matchKey = ident.matchKey;
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
        greenFlagAt: f.greenFlagAt,
        updated_at: new Date().toISOString(),
      };

      if (!out.log.matchKey) unidentified++;

      if (write && schema.ok) {
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

      rows.push(row);
      onRow(row, out.log);

      log(
        '    ' + (out.log.matchKey || 'UNIDENTIFIED').padEnd(16) +
          (last ? last.blue + '-' + last.red : 'n/a').padEnd(10) +
          'q=' + q.score.toFixed(2) + (q.flagged ? ' FLAGGED' : '') + '  ' + row.write
      );
      for (const r of q.reasons) log('      - ' + r);
    }
  } finally {
    if (ownPool) await pool.terminate();
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
