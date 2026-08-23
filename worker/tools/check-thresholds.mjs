/**
 * Are the identification thresholds safe against the whole schedule?
 *
 * Four clips is not a sample you can set a threshold from. But the risk being
 * managed — that a partial read resolves to the *wrong* match — is a property
 * of the schedule, not of the footage, and the schedule is fully known. So
 * enumerate it directly.
 *
 * The OCR's failure mode is dropping a number, not inventing a plausible one:
 * every wrong read seen so far was either a logo fragment (which loses on
 * votes) or a digit-count mismatch (which `recognizePlane` abstains on). So
 * "read k of the 6 teams, correct sides" is the realistic degradation, and
 * every k-subset of every match is a case worth testing.
 *
 * Reports, per k, how many subsets resolve correctly, abstain, or resolve to
 * the WRONG match. Only the last number matters much: an abstention is a
 * dashboard row, a wrong key overwrites a good log.
 *
 *   node worker/tools/check-thresholds.mjs [eventKey]
 */

import { matchBySet } from '../src/identify.mjs';
import { fetchQualSchedule } from '../src/tba.mjs';

const EVENT = process.argv[2] || '2026cagle';

const schedule = await fetchQualSchedule(EVENT);
if (!schedule) {
  console.error(EVENT + ': not on TBA');
  process.exit(1);
}

/** All subsets of `arr` of size `k`. */
function subsets(arr, k) {
  if (k === 0) return [[]];
  if (k > arr.length) return [];
  const [head, ...rest] = arr;
  return [...subsets(rest, k - 1).map((s) => [head, ...s]), ...subsets(rest, k)];
}

console.log(EVENT + ': ' + schedule.length + ' qual matches\n');
console.log(' teams read   correct   abstain     WRONG');

let worstWrong = 0;
for (let k = 2; k <= 6; k++) {
  let correct = 0;
  let abstain = 0;
  let wrong = 0;

  for (const m of schedule) {
    // Split k reads across the two alliances every way they could fall.
    for (let nBlue = Math.max(0, k - 3); nBlue <= Math.min(3, k); nBlue++) {
      const nRed = k - nBlue;
      for (const b of subsets(m.blue, nBlue)) {
        for (const r of subsets(m.red, nRed)) {
          const got = matchBySet(schedule, { blue: b, red: r });
          if (got.matchKey === null) abstain++;
          else if (got.matchKey === m.matchKey) correct++;
          else wrong++;
        }
      }
    }
  }

  worstWrong = Math.max(worstWrong, wrong);
  const total = correct + abstain + wrong;
  console.log(
    '   ' + k + ' of 6  ' +
      String(correct).padStart(9) + String(abstain).padStart(10) + String(wrong).padStart(10) +
      '    (' + total + ' cases, ' + Math.round((100 * correct) / total) + '% identified)'
  );
}

console.log(
  '\n' + (worstWrong === 0
    ? 'No subset of any match resolves to a different match. Wrong keys are not reachable by dropped reads.'
    : 'WARNING: ' + worstWrong + ' subsets resolve to the wrong match.')
);
process.exit(worstWrong === 0 ? 0 : 1);
