/**
 * Targeted validation against the real IRI 2026 Saturday broadcast.
 *
 * The full two-tier scanner works against this URL (proven separately), but
 * scanning the whole ~3.1-hour Saturday window is network-bound and takes on
 * the order of an hour. TBA's `actual_time`, calibrated once against a frame
 * grabbed at the true green flag (see CAL_VIDEO_T below -- `actual_time`
 * itself points at roughly when the match ENDED, not started, measured
 * directly against this footage), lets every Saturday qual's green flag be
 * estimated directly and handed straight to `processMatch`/`identify`,
 * skipping the network-bound scan. `processMatch`'s own PREROLL clock lock
 * self-corrects any small error in the estimate, exactly as it does for a
 * scanner-supplied t0.
 *
 * **Known limitation** (see worker/README.md, "Known limitation: a second
 * broadcast layout the detector misreads"): identification works correctly
 * on this footage; score reading currently returns a flat 0-0, because IRI's
 * overlay stacks the alliance-name label directly above the score rather than
 * beside it, and `detectScoreRegions` was tuned against footage that does the
 * latter. This script still reports the true TBA score for comparison, so a
 * future fix can be checked against it directly.
 *
 *   node worker/tools/iri-saturday-batch.mjs [--matches 54,57,60] [--write]
 */

import { fetchQualSchedule } from '../src/tba.mjs';
import { resolveVodUrl } from '../src/sources.mjs';
import { processMatch, findQuads } from '../src/process.mjs';
import { identify } from '../src/identify.mjs';
import { scoreQuality, agreementWithTba } from '../src/quality.mjs';
import { upsertCvLog, checkSchema } from '../src/supabase.mjs';
import { probe } from '../src/ffmpeg.mjs';
import { createPool, defaultWorkers } from '../src/ocr.mjs';

const EVENT = '2026iri';
const IRI_URL = 'https://www.youtube.com/live/ikCPFWdH8jI?si=MDB5U_DkgSIrjPs8';
/**
 * The one measured calibration point.
 *
 * t=10800 was the first guess (a round 3-hour mark) and it happened to land
 * on qm68's on-screen label, but at 0:00 with the final score already
 * showing -- i.e. near the END of the match, not the start. A frame grabbed
 * at t=10700 read "1:37 remaining in TELEOP" (66s of match elapsed), fixing
 * the real green flag at 10700 - 66 = 10634. `processMatch`'s own PREROLL
 * clock lock absorbs whatever error remains in this estimate for every other
 * match; it does not need to be exact, just within its ~20s window.
 */
const CAL_MATCH = 68;
const CAL_VIDEO_T = 10634;

function flag(name, fallbackValue) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallbackValue;
}
const write = process.argv.includes('--write');
const matchArg = flag('matches', null);

const schedule = await fetchQualSchedule(EVENT);
console.log(EVENT + ': ' + schedule.length + ' qual matches on TBA');

const sat = schedule.filter((m) => m.matchNumber >= 54);
const cal = sat.find((m) => m.matchNumber === CAL_MATCH);
const estimateT0 = (m) => CAL_VIDEO_T + (m.actualTime - cal.actualTime);

const targets = matchArg
  ? sat.filter((m) => matchArg.split(',').map(Number).includes(m.matchNumber))
  : sat.filter((m) => [54, 58, 62, 66, 70, 75].includes(m.matchNumber)); // spread across the window

console.log('targets: ' + targets.map((m) => 'qm' + m.matchNumber).join(', '));

const schema = write ? await checkSchema().catch(() => ({ ok: false, message: 'unreachable' })) : null;
if (write && !schema.ok) console.log('cannot write: ' + schema.message + ' (continuing as dry run)');

console.log('resolving direct URL...');
const url = await resolveVodUrl(IRI_URL);
const meta = await probe(url);
console.log('resolved  ' + meta.width + 'x' + meta.height + '  ' + (meta.duration / 3600).toFixed(1) + 'h\n');

const pool = await createPool(defaultWorkers());
const results = [];

try {
  for (const m of targets) {
    const est = estimateT0(m);
    console.log('qm' + m.matchNumber + '  estimated t0=' + est.toFixed(0) + 's ...');

    let quads;
    try {
      quads = await findQuads(url, est, meta);
    } catch (e) {
      console.log('  ! findQuads failed: ' + e.message);
      results.push({ match: m.matchNumber, error: 'findQuads: ' + e.message });
      continue;
    }
    if (!quads) {
      console.log('  ! no quads found near t=' + est);
      results.push({ match: m.matchNumber, error: 'no quads' });
      continue;
    }

    const out = await processMatch(url, est, {
      pool, meta, quads, eventKey: EVENT, sourceLabel: 'IRI 2026 Saturday broadcast',
    });

    const ident = await identify(url, est, schedule, { pool, meta, quads });
    if (ident.matchKey) out.log.matchKey = ident.matchKey;

    const quality = scoreQuality(out.log, out.diagnostics, ident);
    out.log.quality = quality;
    out.log.flagged = quality.flagged;
    out.log.rawReads = out.rawReads;

    const last = out.log.samples[out.log.samples.length - 1];
    const tba = agreementWithTba(out.log, m.blueScore, m.redScore);

    const wantKey = m.matchKey;
    const idVerdict = !ident.matchKey ? 'ABSTAIN' : ident.matchKey === wantKey ? 'correct' : 'WRONG';

    console.log(
      '  read ' + (last ? last.blue + '-' + last.red : 'n/a') +
        '  tba ' + m.blueScore + '-' + m.redScore +
        (tba ? '  Δ' + tba.delta.blue + '/' + tba.delta.red + (tba.within ? ' (agrees)' : ' (differs)') : '') +
        '  |  id: ' + (ident.matchKey || 'none') + ' want ' + wantKey + ' [' + idVerdict + ']' +
        '  q=' + quality.score.toFixed(2) + (quality.flagged ? ' FLAGGED' : '')
    );

    let writeResult = { written: false, reason: 'dry run' };
    if (write && schema?.ok) {
      writeResult = await upsertCvLog(out.log, {});
      if (!writeResult.written) console.log('  ! ' + writeResult.reason);
    }

    results.push({
      match: m.matchNumber,
      matchKey: wantKey,
      estimatedT0: est,
      finalRead: last ? { blue: last.blue, red: last.red } : null,
      tbaScore: { blue: m.blueScore, red: m.redScore },
      tbaAgreement: tba,
      identification: { got: ident.matchKey, want: wantKey, verdict: idVerdict, method: ident.method, score: ident.score, runnerUp: ident.runnerUp },
      quality: { score: quality.score, flagged: quality.flagged, reasons: quality.reasons },
      write: writeResult.written ? 'written' : writeResult.reason,
    });
  }
} finally {
  await pool.terminate();
}

console.log('\n=== summary ===');
const idCorrect = results.filter((r) => r.identification?.verdict === 'correct').length;
const idWrong = results.filter((r) => r.identification?.verdict === 'WRONG').length;
const idAbstain = results.filter((r) => r.identification?.verdict === 'ABSTAIN').length;
const scoreAgree = results.filter((r) => r.tbaAgreement?.within).length;
console.log(results.length + ' matches processed');
console.log('identification: ' + idCorrect + ' correct, ' + idAbstain + ' abstained, ' + idWrong + ' WRONG');
console.log('score agreement with TBA (±25pt): ' + scoreAgree + '/' + results.filter((r) => r.tbaAgreement).length);

const { writeFileSync } = await import('node:fs');
writeFileSync('worker/tools/_iri_batch_results.json', JSON.stringify(results, null, 2));
console.log('\nfull results: worker/tools/_iri_batch_results.json');
