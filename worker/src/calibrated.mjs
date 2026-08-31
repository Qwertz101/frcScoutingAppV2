/**
 * Using a layout a human taught us, instead of inferring one from pixels.
 *
 * When an event has a calibrated layout, the whole detection problem goes away:
 * the quads are simply known. That removes the failure this pipeline keeps
 * hitting -- IRI's two-row scoreboard read 0-0 for a night because the detector
 * locked onto the row of alliance labels above the scores, and a hand-held
 * recording from the stands is harder again. Nobody has to out-think that if a
 * person has already pointed at the right boxes.
 *
 * Detection stays as the fallback, unchanged. An event with no layout behaves
 * exactly as before, which is what keeps the proven MP4 path working.
 */

import { rectQuad } from './core.mjs';
import { readEnv } from './tba.mjs';

/** `2026iri` -> 2026. 0 when the key does not start with a season. */
export function seasonOf(eventKey) {
  const m = /^(\d{4})/.exec(String(eventKey ?? '').trim());
  return m ? Number(m[1]) : 0;
}

function config() {
  const url = readEnv('SUPABASE_URL');
  const key = readEnv('SUPABASE_ANON_KEY');
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

/**
 * The calibrated layout for an event, or null.
 *
 * Never throws: a worker that cannot reach Supabase should fall back to
 * detection and keep scanning, not stop. The caller logs the reason.
 */
export async function fetchCalibratedLayout(eventKey) {
  if (!eventKey) return null;
  const cfg = config();
  if (!cfg) return null;
  try {
    const res = await fetch(
      cfg.url + '/rest/v1/cv_layouts?event_key=eq.' + encodeURIComponent(eventKey) + '&select=*',
      { headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !row.boxes) return null;
    return {
      eventKey: row.event_key,
      season: row.season,
      label: row.label ?? '',
      boxes: row.boxes,
      frameSize: row.frame_size ?? null,
      verified: row.verified ?? null,
    };
  } catch {
    return null;
  }
}

const toQuad = (r) => rectQuad(r.x0, r.y0, r.x1, r.y1);

/**
 * The score/timer quads, in the shape `detectScoreRegions` returns.
 *
 * Fractions of frame size throughout, so a layout taught on a 1080p feed still
 * applies to a 720p one of the same broadcast -- which matters because the
 * worker asks for the best stream available and that is not always the same
 * height twice.
 */
export function quadsFromLayout(layout) {
  if (!layout?.boxes) return null;
  const b = layout.boxes;
  if (!b.blueScore || !b.redScore || !b.timer) return null;
  return {
    blue: toQuad(b.blueScore),
    red: toQuad(b.redScore),
    timer: toQuad(b.timer),
  };
}

/** The six team-number quads, or null when the layout did not include them. */
export function teamQuadsFromLayout(layout) {
  const b = layout?.boxes;
  if (!b?.blueTeams?.length || !b?.redTeams?.length) return null;
  return {
    blue: b.blueTeams.map(toQuad),
    red: b.redTeams.map(toQuad),
  };
}

/**
 * A sanity check before a calibrated layout is trusted for a whole event.
 *
 * Cheap, and worth it: a layout with a box outside the frame or inverted is a
 * calibration that will read nothing for eighty matches, and it is far better
 * to fall back to detection with a warning than to write eighty empty logs.
 */
export function validateLayout(layout) {
  const b = layout?.boxes;
  if (!b) return 'no boxes';
  const check = (r, name) => {
    if (!r || typeof r.x0 !== 'number') return name + ' missing';
    for (const [k, v] of Object.entries(r)) {
      if (!Number.isFinite(v) || v < 0 || v > 1) return name + '.' + k + ' out of range';
    }
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return name + ' has no area';
    return null;
  };
  for (const [name, r] of [['blueScore', b.blueScore], ['redScore', b.redScore], ['timer', b.timer]]) {
    const err = check(r, name);
    if (err) return err;
  }
  for (const side of ['blueTeams', 'redTeams']) {
    if (!b[side]) continue;
    for (let i = 0; i < b[side].length; i++) {
      const err = check(b[side][i], side + '[' + i + ']');
      if (err) return err;
    }
  }
  return null;
}
