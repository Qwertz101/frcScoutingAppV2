/**
 * Back-fill `quality.tbaAgreement` once TBA has posted real scores.
 *
 * The rest of the pipeline runs close to a match ending; TBA's official
 * results follow minutes to hours later (an FTA fixing a scoring error, a
 * playback review, sometimes just posting lag). Nothing earlier in the
 * pipeline can compare against them, so this is a deliberately separate,
 * later pass -- run once after quals wrap, or periodically during an event.
 *
 *   node worker/src/reconcile.mjs <eventKey>            # dry run
 *   node worker/src/reconcile.mjs <eventKey> --write     # persist
 *
 * **Advisory only, and this is the one invariant that must never slip.**
 * `agreementWithTba` (quality.mjs) never changes `score` or `flagged` -- this
 * session measured a *correct* OCR read disagree with TBA by 20+ points
 * because the on-screen overlay was still settling when the recording ended.
 * If reconcile ever started adjusting `score` on the strength of a TBA
 * mismatch, a slow reveal would silently flag good logs as bad. So this pass
 * only ever adds `tbaAgreement` to a quality object that already exists; it
 * never touches `score`, `flagged`, or `reasons`.
 */

import { fetchQualSchedule } from './tba.mjs';
import { fetchCvLogsForReconcile, patchTbaAgreement } from './supabase.mjs';
import { agreementWithTba } from './quality.mjs';

/**
 * Reconcile one event.
 *
 * Returns a summary rather than throwing on a per-match problem: one match
 * TBA hasn't scored yet, or one write the human-row guard refused, should not
 * stop the rest of the event from being reconciled.
 */
export async function reconcileEvent(eventKey, opts = {}) {
  const write = Boolean(opts.write);
  const log = opts.log ?? (() => {});

  const schedule = await fetchQualSchedule(eventKey);
  if (!schedule) return { ok: false, reason: eventKey + ' not found on TBA' };

  const byKey = new Map(schedule.map((m) => [m.matchKey, m]));

  const { ok, message, rows } = await fetchCvLogsForReconcile(eventKey);
  if (!ok) return { ok: false, reason: message };

  log(rows.length + ' worker-written log(s) for ' + eventKey);

  const results = [];
  for (const row of rows) {
    const m = byKey.get(row.match_key);
    if (!m) {
      results.push({ matchKey: row.match_key, status: 'not on TBA schedule' });
      continue;
    }
    if (m.blueScore == null || m.redScore == null) {
      results.push({ matchKey: row.match_key, status: 'TBA has not posted a score yet' });
      continue;
    }

    const agreement = agreementWithTba({ samples: row.samples }, m.blueScore, m.redScore);
    if (!agreement) {
      results.push({ matchKey: row.match_key, status: 'no samples to compare' });
      continue;
    }

    const quality = { ...(row.quality ?? {}), tbaAgreement: agreement };
    // score/flagged/reasons are carried through completely untouched -- see
    // the module docstring for why that is load-bearing, not incidental.

    let writeResult = { written: false, reason: 'dry run' };
    if (write) writeResult = await patchTbaAgreement(row.match_key, quality, opts);

    results.push({
      matchKey: row.match_key,
      status: agreement.within ? 'agrees' : 'disagrees',
      ours: agreement.ours,
      tba: agreement.tba,
      delta: agreement.delta,
      write: writeResult.written ? 'written' : writeResult.reason,
    });
    log(
      '  ' + row.match_key.padEnd(18) +
        (agreement.within ? 'agrees  ' : 'DISAGREES') + '  ours ' +
        agreement.ours.blue + '-' + agreement.ours.red + '  tba ' +
        agreement.tba.blue + '-' + agreement.tba.red + '  Δ' +
        agreement.delta.blue + '/' + agreement.delta.red +
        '  ' + (write ? (writeResult.written ? 'written' : '! ' + writeResult.reason) : 'dry run')
    );
  }

  return { ok: true, eventKey, results };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('worker/src/reconcile.mjs');

if (invokedDirectly) {
  const eventKey = process.argv[2];
  if (!eventKey) {
    console.error('usage: node worker/src/reconcile.mjs <eventKey> [--write] [--force]');
    process.exit(1);
  }
  const write = process.argv.includes('--write');
  const force = process.argv.includes('--force');

  const out = await reconcileEvent(eventKey, { write, force, log: (m) => console.error(m) });
  if (!out.ok) {
    console.error(out.reason);
    process.exit(1);
  }

  const disagree = out.results.filter((r) => r.status === 'disagrees').length;
  const noScore = out.results.filter((r) => r.status === 'TBA has not posted a score yet').length;
  console.error(
    '\n' + out.results.length + ' log(s): ' +
      (out.results.length - disagree - noScore) + ' agree, ' +
      disagree + ' disagree (advisory -- not flagged for it), ' +
      noScore + ' not yet scored on TBA'
  );
  if (!write) console.error('dry run — nothing was written. Pass --write to persist.');
}
