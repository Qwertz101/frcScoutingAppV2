/**
 * Writing logs to Supabase, worker side.
 *
 * Deliberately not `src/services/bpsStore.ts` or `supabaseClient.ts`. The
 * former is localStorage-backed and gates its sync on `navigator.onLine`,
 * neither of which exists here; the latter reads `import.meta.env`. This is a
 * thin REST client instead, writing the identical column layout so the app
 * reads worker rows and hand-made rows the same way.
 *
 * The one rule that matters:
 *
 *   `match_key` is the PRIMARY KEY and this upserts on it. A write to a key
 *   that already holds a human's corrections does not merge with them, it
 *   REPLACES them. So every write checks who wrote the row first, and refuses
 *   to overwrite anything a person touched unless explicitly forced.
 *
 * That check costs one indexed lookup per match. It is the difference between a
 * helpful robot and one that quietly erases the scouting lead's 11pm
 * corrections the next time the video is reprocessed.
 */

import { readEnv } from './tba.mjs';

/** Logs the worker itself produced carry this prefix in `source`. */
export const WORKER_SOURCE_PREFIX = 'auto-worker';

function config() {
  const url = readEnv('SUPABASE_URL');
  const key = readEnv('SUPABASE_ANON_KEY');
  if (!url || !key) {
    throw new Error(
      'no SUPABASE_URL / SUPABASE_ANON_KEY — put them in worker/.env or reuse the app\'s .env.local'
    );
  }
  return { url: url.replace(/\/$/, ''), key };
}

async function rest(path, init = {}) {
  const { url, key } = config();
  const res = await fetch(url + '/rest/v1' + path, {
    ...init,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Supabase ' + res.status + ' ' + path + (body ? ': ' + body : ''));
  }
  // Parse only when there is something to parse, rather than trusting the
  // status code to tell us. `Prefer: return=minimal` is answered with an empty
  // body, but PostgREST sends it as **201 Created** on an insert, not 204 --
  // measured against this project's own database. So the 204 check missed it,
  // `res.json()` ran on a zero-length body, and the write failed with
  // "Unexpected end of JSON input" *after the row had already been inserted*.
  // A whole capture died on its first successful write, seven matches short,
  // reporting an error for something that had actually worked.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Who last wrote this match, if anyone.
 *
 * Selects only base-schema columns, deliberately. This is the guard that stops
 * the worker overwriting a person's corrections, and an earlier version asked
 * for `flagged` as well — which meant that on a database where the M6 migration
 * had not been run yet, the guard threw before it could refuse anything. The
 * protection has to work on the schema that exists, not the one that should.
 */
export async function existingSource(matchKey) {
  const rows = await rest(
    '/cv_logs?match_key=eq.' + encodeURIComponent(matchKey) + '&select=source,updated_at'
  );
  return rows && rows.length ? rows[0] : null;
}

/** Columns the M6 migration adds. Absent until someone runs the SQL by hand. */
const M6_COLUMNS = ['quality', 'flagged', 'raw_reads'];

/**
 * Is the database migrated for this worker?
 *
 * Checked up front and reported in words, because the raw failure is a
 * PostgREST `42703` naming one column, which does not obviously mean "go and
 * run supabase/schema-bps.sql".
 */
export async function checkSchema() {
  try {
    await rest('/cv_logs?select=' + M6_COLUMNS.join(',') + '&limit=1');
    return { ok: true };
  } catch (e) {
    const m = /column cv_logs\.(\w+) does not exist/.exec(String(e.message));
    if (!m) throw e;
    return {
      ok: false,
      missing: m[1],
      message:
        'cv_logs is missing the column "' + m[1] + '". The M6 columns have not ' +
        'been added yet — run the `alter table` statements at the top of ' +
        'supabase/schema-bps.sql against the project, then retry.',
    };
  }
}

/** Was this row written by the worker rather than by a person? */
export const isWorkerRow = (source) =>
  typeof source === 'string' && source.startsWith(WORKER_SOURCE_PREFIX);

/**
 * Write one log.
 *
 * Returns `{ written: false, reason }` rather than throwing when the row
 * belongs to a human — refusing is a normal outcome here, not an error, and it
 * should show up on the dashboard as a row to look at rather than as a crash
 * that stops the rest of the event being processed.
 */
export async function upsertCvLog(log, opts = {}) {
  if (!log.matchKey) {
    return { written: false, reason: 'no match key — nothing to write against' };
  }

  const schema = await checkSchema();
  if (!schema.ok) return { written: false, reason: schema.message };

  const existing = await existingSource(log.matchKey);
  if (existing && !isWorkerRow(existing.source) && !opts.force) {
    return {
      written: false,
      reason:
        'refusing to overwrite ' + log.matchKey + ': existing row is "' +
        existing.source + '", not the worker\'s. Pass --force to replace it.',
      existing,
    };
  }

  const row = {
    match_key: log.matchKey,
    event_key: log.eventKey || null,
    source: log.source,
    samples: log.samples ?? [],
    quality: log.quality ?? null,
    flagged: Boolean(log.flagged),
    raw_reads: log.rawReads ?? null,
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };

  await rest('/cv_logs?on_conflict=match_key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([row]),
  });

  return { written: true, replaced: Boolean(existing) };
}

/** Every log for an event, newest first. Used by the dashboard. */
export async function fetchCvLogs(eventKey) {
  const q = eventKey ? '&event_key=eq.' + encodeURIComponent(eventKey) : '';
  const schema = await checkSchema();
  // Degrade rather than fail: on an unmigrated database the dashboard should
  // still list what is there and say why the quality column is blank.
  const cols = schema.ok
    ? 'match_key,event_key,source,quality,flagged,updated_at'
    : 'match_key,event_key,source,updated_at';
  const rows =
    (await rest('/cv_logs?select=' + cols + '&deleted_at=is.null' + q + '&order=updated_at.desc')) ?? [];
  return schema.ok ? rows : rows.map((r) => ({ ...r, quality: null, flagged: false, unmigrated: true }));
}

/**
 * Every worker-written log for an event, WITH samples -- what the reconcile
 * pass needs to compare a final score against TBA's, that `fetchCvLogs`
 * deliberately omits (the dashboard lists many rows at once; shipping every
 * match's ~163-row sample array to it for nothing it displays is waste).
 *
 * Filtered to worker rows server-side, not just guarded on write: reconcile
 * has no business even reading a human's hand-corrected samples to compare
 * against TBA, since `tbaAgreement` is advisory and the comparison is only
 * meaningful against what the OCR itself produced.
 */
export async function fetchCvLogsForReconcile(eventKey) {
  const schema = await checkSchema();
  if (!schema.ok) return { ok: false, message: schema.message, rows: [] };
  const rows = await rest(
    '/cv_logs?select=match_key,samples,quality,source' +
      '&event_key=eq.' + encodeURIComponent(eventKey) +
      '&deleted_at=is.null' +
      '&source=like.' + encodeURIComponent(WORKER_SOURCE_PREFIX + '%')
  );
  return { ok: true, rows: rows ?? [] };
}

/**
 * Patch `quality.tbaAgreement` on one log, and nothing else.
 *
 * Not `upsertCvLog`: reconcile only ever amends a row that already exists
 * (there is nothing to reconcile against for a match the worker never wrote),
 * and folding this through the full upsert path would mean re-sending
 * `samples` for no reason and re-running the human-row guard's write path for
 * an operation that is not really a write in the same sense. A plain PATCH,
 * still guarded the same way -- refuse anything not written by the worker.
 */
export async function patchTbaAgreement(matchKey, quality, opts = {}) {
  const existing = await existingSource(matchKey);
  if (!existing) return { written: false, reason: matchKey + ': no such row' };
  if (!isWorkerRow(existing.source) && !opts.force) {
    return { written: false, reason: matchKey + ': not a worker row, refusing to touch it' };
  }
  await rest('/cv_logs?match_key=eq.' + encodeURIComponent(matchKey), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ quality, updated_at: new Date().toISOString() }),
  });
  return { written: true };
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('worker/src/supabase.mjs');

if (invokedDirectly) {
  const eventKey = process.argv[2] ?? '';
  const rows = await fetchCvLogs(eventKey);
  console.error(rows.length + ' cv_logs row(s)' + (eventKey ? ' for ' + eventKey : ''));
  for (const r of rows.slice(0, 20)) {
    console.error(
      '  ' + r.match_key.padEnd(18) +
        (isWorkerRow(r.source) ? 'worker' : 'human ') +
        '  q=' + (r.quality?.score ?? '--') +
        (r.flagged ? '  FLAGGED' : '')
    );
  }
}
