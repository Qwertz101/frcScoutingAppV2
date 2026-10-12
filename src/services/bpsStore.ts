import { CvMatchLog, CvQuality, CvRawRead, TimelineScoutingData } from '../types';
import { uuidv4 } from '../utils/uuid';
import supabase from './supabaseClient';
import { DataService } from './dataService';
import { WORKER_BASE } from './cv/captureWorker';

/**
 * Storage for the two BPS streams.
 *
 * Kept separate from DataService because these are a different shape with a
 * different sync cadence: timelines are written once per match by a phone that
 * may be offline, CV logs are written in bulk by one laptop. Both follow the
 * same local-first pattern as the rest of the app — write to localStorage
 * immediately, push to Supabase opportunistically, and never lose a row
 * because the network was down.
 */

const KEYS = {
  TIMELINES: 'frc-bps-timelines',
  CV_LOGS: 'frc-bps-cv-logs',
  PENDING_TIMELINES: 'frc-bps-pending-timelines',
  PENDING_CV: 'frc-bps-pending-cv',
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // Quota is a real risk here: a full event of per-second CV logs is large.
    console.error(`bpsStore: failed to persist ${key}`, e);
    throw e;
  }
}

function inEvent(matchKey: string, eventKey: string): boolean {
  return matchKey.startsWith(eventKey + '_');
}

/** Supabase defaults to 1000 rows; a full event can exceed that easily. */
async function fetchPages(table: string, eventKey?: string): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    let query = supabase!.from(table).select('*').order(table === 'cv_logs' ? 'match_key' : 'id');
    if (eventKey) query = query.like('match_key', eventKey.replace(/[\\%_]/g, '\\$&') + '\\_%');
    const { data, error } = await query.range(from, from + 999).abortSignal(AbortSignal.timeout(10_000));
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
  }
}

/** Completed worker captures are also available locally when Supabase is down.
 * Unidentified captures are never attached to a match by guessing.
 */
export async function fetchLocalWorkerLogs(eventKey: string): Promise<CvMatchLog[]> {
  const response = await fetch(WORKER_BASE + '/api/state', { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  if (!response.ok) throw new Error('Worker unavailable');
  const state = await response.json();
  const pending = new Set(readJson<string[]>(KEYS.PENDING_CV, []));
  const all = readJson<CvMatchLog[]>(KEYS.CV_LOGS, []);
  const byMatch = new Map(all.map((l) => [l.matchKey, l]));
  for (const row of state.rows ?? []) {
    if (!row.match_key || !inEvent(row.match_key, eventKey) || !row.local_file || pending.has(row.match_key)) continue;
    const previous = byMatch.get(row.match_key);
    const updated = Date.parse(row.updated_at);
    if (previous && Number.isFinite(updated) && (previous.updatedAt ?? previous.createdAt) >= updated) continue;
    try {
      const res = await fetch(WORKER_BASE + '/api/logs/' + encodeURIComponent(row.local_file), {
        signal: AbortSignal.timeout(10_000), cache: 'no-store',
      });
      if (!res.ok) continue;
      const log = parseCvJson(await res.text(), eventKey);
      if (log.matchKey !== row.match_key) continue;
      // Re-read pending state after network I/O so a concurrent manual edit wins.
      if (readJson<string[]>(KEYS.PENDING_CV, []).includes(log.matchKey)) continue;
      byMatch.set(log.matchKey, { ...log, updatedAt: Number.isFinite(updated) ? updated : log.createdAt });
    } catch { /* A malformed/unreachable capture must not block the others. */ }
  }
  // Include anything saved while the worker requests were in flight.
  const latestPending = new Set(readJson<string[]>(KEYS.PENDING_CV, []));
  for (const log of readJson<CvMatchLog[]>(KEYS.CV_LOGS, [])) {
    const fetched = byMatch.get(log.matchKey);
    if (!fetched || latestPending.has(log.matchKey) || (log.updatedAt ?? log.createdAt) > (fetched.updatedAt ?? fetched.createdAt)) byMatch.set(log.matchKey, log);
  }
  writeJson(KEYS.CV_LOGS, [...byMatch.values()]);
  return getCvLogs();
}

function notifyChanged(): void {
  window.dispatchEvent(new Event('bps-data-updated'));
}

/* ------------------------------------------------------------------ *
 * Stream 1 — human action timelines
 * ------------------------------------------------------------------ */

export function getTimelines(): TimelineScoutingData[] {
  return readJson<TimelineScoutingData[]>(KEYS.TIMELINES, []);
}

export function saveTimeline(record: Omit<TimelineScoutingData, 'id'> & { id?: string }): TimelineScoutingData {
  const full: TimelineScoutingData = {
    ...record,
    id: record.id || uuidv4(),
    timestamp: record.timestamp || Date.now(),
  };

  const all = getTimelines();
  // One timeline per scouter per robot per match: re-scouting overwrites
  // rather than accumulating duplicates the solver would have to dedupe.
  const idx = all.findIndex(
    (t) =>
      t.id === full.id ||
      (t.matchKey === full.matchKey && t.teamKey === full.teamKey && t.scouter === full.scouter)
  );
  if (idx >= 0) all[idx] = full;
  else all.push(full);

  writeJson(KEYS.TIMELINES, all);

  const pending = new Set(readJson<string[]>(KEYS.PENDING_TIMELINES, []));
  pending.add(full.id);
  writeJson(KEYS.PENDING_TIMELINES, [...pending]);

  notifyChanged();
  void pushTimelines();
  return full;
}

export function findTimeline(matchKey: string, teamKey: string, scouter: string) {
  return getTimelines().find(
    (t) => t.matchKey === matchKey && t.teamKey === teamKey && t.scouter === scouter
  );
}

/** Push any unsynced timelines. Safe to call repeatedly; no-ops when offline. */
type PushResult = { pushed: number; error?: string };
let timelinePush: Promise<PushResult> | null = null;
let cvPush: Promise<PushResult> | null = null;
export function pushTimelines(): Promise<PushResult> {
  if (!supabase || !navigator.onLine) return Promise.resolve({ pushed: 0, error: 'offline' });
  return timelinePush ?? (timelinePush = pushTimelineBatch().finally(() => { timelinePush = null; }));
}

async function pushTimelineBatch(): Promise<PushResult> {
  if (!supabase || !navigator.onLine) return { pushed: 0, error: 'offline' };

  const pending = readJson<string[]>(KEYS.PENDING_TIMELINES, []);
  if (!pending.length) return { pushed: 0 };

  const all = getTimelines();
  const rows = all
    .filter((t) => pending.includes(t.id))
    .map((t) => ({
      id: t.id,
      match_key: t.matchKey,
      team_key: t.teamKey,
      scouter_name: t.scouter,
      alliance: t.alliance,
      position: t.position,
      payload: {
        segments: t.segments,
        climb: t.climb,
        confidence: t.confidence,
        endedEarly: t.endedEarly ?? false,
        kind: 'timeline',
      },
      client_id: DataService.getClientId(),
      timestamp: new Date(t.timestamp).toISOString(),
    }));

  if (!rows.length) {
    writeJson(KEYS.PENDING_TIMELINES, []);
    return { pushed: 0 };
  }

  try {
    const { error } = await supabase.from('timeline_records').upsert(rows, { onConflict: 'id' }).abortSignal(AbortSignal.timeout(10_000));
    if (error) throw error;
    // A scout may save another robot (or re-edit this one) during the request.
    // Acknowledge only the exact versions actually sent, never the whole queue.
    const sent = new Map(all.filter((t) => pending.includes(t.id)).map((t) => [t.id, JSON.stringify(t)]));
    const acknowledged = new Set(getTimelines().filter((t) => sent.get(t.id) === JSON.stringify(t)).map((t) => t.id));
    writeJson(KEYS.PENDING_TIMELINES, readJson<string[]>(KEYS.PENDING_TIMELINES, []).filter((id) => !acknowledged.has(id)));
    return { pushed: rows.length };
  } catch (e: any) {
    console.warn('bpsStore: timeline push failed, will retry', e);
    return { pushed: 0, error: String(e?.message || e) };
  }
}

/** Pull server timelines and merge them over the local copy. */
export async function fetchTimelines(eventKey?: string): Promise<TimelineScoutingData[]> {
  if (!supabase) return getTimelines();

  const data = await fetchPages('timeline_records', eventKey);

  const server: TimelineScoutingData[] = (data ?? []).map((r: any) => ({
    id: r.id,
    matchKey: r.match_key,
    teamKey: r.team_key,
    scouter: r.scouter_name,
    alliance: r.alliance,
    position: r.position ?? 0,
    segments: r.payload?.segments ?? [],
    climb: r.payload?.climb ?? 'none',
    confidence: r.payload?.confidence ?? 'moderate',
    endedEarly: r.payload?.endedEarly ?? false,
    timestamp: r.timestamp ? Date.parse(r.timestamp) : Date.now(),
  }));

  // Local pending rows win — they have not reached the server yet.
  const pending = new Set(readJson<string[]>(KEYS.PENDING_TIMELINES, []));
  const local = getTimelines();
  const merged = new Map<string, TimelineScoutingData>();
  for (const t of server) merged.set(t.id, t);
  for (const t of local) {
    const remote = merged.get(t.id);
    if (!remote || pending.has(t.id) || t.timestamp > remote.timestamp) merged.set(t.id, t);
  }

  const out = [...merged.values()];
  writeJson(KEYS.TIMELINES, out);
  return out;
}

/* ------------------------------------------------------------------ *
 * Stream 2 — CV scoreboard logs
 * ------------------------------------------------------------------ */

export function getCvLogs(): CvMatchLog[] {
  return readJson<CvMatchLog[]>(KEYS.CV_LOGS, []).filter((l) => !l.deletedAt);
}

export function getCvLog(matchKey: string): CvMatchLog | undefined {
  return getCvLogs().find((l) => l.matchKey === matchKey);
}

export function saveCvLog(log: CvMatchLog): CvMatchLog {
  const full: CvMatchLog = {
    ...log,
    createdAt: log.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  const all = readJson<CvMatchLog[]>(KEYS.CV_LOGS, []);
  const idx = all.findIndex((l) => l.matchKey === full.matchKey);
  if (idx >= 0) all[idx] = full;
  else all.push(full);

  writeJson(KEYS.CV_LOGS, all);

  const pending = new Set(readJson<string[]>(KEYS.PENDING_CV, []));
  pending.add(full.matchKey);
  writeJson(KEYS.PENDING_CV, [...pending]);

  notifyChanged();
  void pushCvLogs();
  return full;
}

export function deleteCvLog(matchKey: string): void {
  const all = readJson<CvMatchLog[]>(KEYS.CV_LOGS, []);
  const idx = all.findIndex((l) => l.matchKey === matchKey);
  if (idx < 0) return;
  all[idx] = { ...all[idx], deletedAt: Date.now(), updatedAt: Date.now() };
  writeJson(KEYS.CV_LOGS, all);
  const pending = new Set(readJson<string[]>(KEYS.PENDING_CV, []));
  pending.add(matchKey);
  writeJson(KEYS.PENDING_CV, [...pending]);
  notifyChanged();
  void pushCvLogs();
}

export function pushCvLogs(): Promise<PushResult> {
  if (!supabase || !navigator.onLine) return Promise.resolve({ pushed: 0, error: 'offline' });
  return cvPush ?? (cvPush = pushCvBatch().finally(() => { cvPush = null; }));
}
async function pushCvBatch(): Promise<PushResult> {
  if (!supabase || !navigator.onLine) return { pushed: 0, error: 'offline' };

  const pending = readJson<string[]>(KEYS.PENDING_CV, []);
  if (!pending.length) return { pushed: 0 };

  const all = readJson<CvMatchLog[]>(KEYS.CV_LOGS, []);
  const rows = all
    .filter((l) => pending.includes(l.matchKey))
    .map((l) => ({
      match_key: l.matchKey,
      event_key: l.eventKey,
      source: l.source,
      samples: l.samples,
      deleted_at: l.deletedAt ? new Date(l.deletedAt).toISOString() : null,
      updated_at: new Date(l.updatedAt ?? Date.now()).toISOString(),
    }));

  if (!rows.length) {
    writeJson(KEYS.PENDING_CV, []);
    return { pushed: 0 };
  }

  try {
    const { error } = await supabase.from('cv_logs').upsert(rows, { onConflict: 'match_key' }).abortSignal(AbortSignal.timeout(10_000));
    if (error) throw error;
    const sent = new Map(all.filter((l) => pending.includes(l.matchKey)).map((l) => [l.matchKey, JSON.stringify(l)]));
    const current = readJson<CvMatchLog[]>(KEYS.CV_LOGS, []);
    const acknowledged = new Set(current.filter((l) => sent.get(l.matchKey) === JSON.stringify(l)).map((l) => l.matchKey));
    writeJson(KEYS.PENDING_CV, readJson<string[]>(KEYS.PENDING_CV, []).filter((key) => !acknowledged.has(key)));
    return { pushed: rows.length };
  } catch (e: any) {
    console.warn('bpsStore: CV log push failed, will retry', e);
    return { pushed: 0, error: String(e?.message || e) };
  }
}

export async function fetchCvLogs(eventKey?: string): Promise<CvMatchLog[]> {
  if (!supabase) return getCvLogs();

  const data = await fetchPages('cv_logs', eventKey);

  const server: CvMatchLog[] = (data ?? []).map((r: any) => ({
    matchKey: r.match_key,
    eventKey: r.event_key,
    source: r.source ?? 'unknown',
    samples: r.samples ?? [],
    createdAt: r.created_at ? Date.parse(r.created_at) : Date.now(),
    updatedAt: r.updated_at ? Date.parse(r.updated_at) : undefined,
    deletedAt: r.deleted_at ? Date.parse(r.deleted_at) : null,
    // Carried, not dropped. These are what tell a worker-written log from a
    // hand-made one and what drives the chip colours and the review queue --
    // leaving them behind meant every match the worker captured came back
    // looking like an ordinary upload with no quality attached.
    quality: r.quality ?? undefined,
    flagged: Boolean(r.flagged),
    rawReads: r.raw_reads ?? undefined,
    video: r.video ?? undefined,
  }));

  const pending = new Set(readJson<string[]>(KEYS.PENDING_CV, []));
  const local = readJson<CvMatchLog[]>(KEYS.CV_LOGS, []);
  const merged = new Map<string, CvMatchLog>();
  for (const l of server) merged.set(l.matchKey, l);
  for (const l of local) {
    const remote = merged.get(l.matchKey);
    if (!remote || pending.has(l.matchKey) ||
      (l.updatedAt ?? l.createdAt) > (remote.updatedAt ?? remote.createdAt)) merged.set(l.matchKey, l);
  }

  const out = [...merged.values()];
  writeJson(KEYS.CV_LOGS, out);
  return out.filter((l) => !l.deletedAt);
}

/* ------------------------------------------------------------------ *
 * JSON interchange — the shared-drive step in the procedure
 * ------------------------------------------------------------------ */

export function cvLogToJson(log: CvMatchLog): string {
  return JSON.stringify(
    {
      version: 1,
      matchKey: log.matchKey,
      eventKey: log.eventKey,
      source: log.source,
      createdAt: log.createdAt,
      samples: log.samples,
      quality: log.quality,
      flagged: log.flagged,
      video: log.video,
      rawReads: log.rawReads,
    },
    null,
    2
  );
}

export function downloadCvLog(log: CvMatchLog): void {
  const blob = new Blob([cvLogToJson(log)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cv-${log.matchKey}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Parse a CV JSON produced by this app (or hand-authored to the same shape). */
export function parseCvJson(text: string, fallbackEventKey = ''): CvMatchLog {
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== 'object') throw new Error('Not a JSON object');
  if (!obj.matchKey) throw new Error('Missing matchKey');
  if (!Array.isArray(obj.samples)) throw new Error('Missing samples array');

  const samples = obj.samples.map((s: any, i: number) => {
    const sec = Number(s.sec);
    if (!Number.isFinite(sec)) throw new Error(`Sample ${i} has a non-numeric sec`);
    return {
      sec,
      ...(Number.isFinite(s.videoSec) ? { videoSec: s.videoSec } : {}),
      ...(typeof s.blueAccepted === 'boolean' ? { blueAccepted: s.blueAccepted } : {}),
      ...(typeof s.redAccepted === 'boolean' ? { redAccepted: s.redAccepted } : {}),
      phase: s.phase === 'auto' ? 'auto' : 'teleop',
      blue: Number(s.blue) || 0,
      red: Number(s.red) || 0,
      db: Number(s.db) || 0,
      dr: Number(s.dr) || 0,
    };
  });

  // Built field by field rather than spread, so a malformed import cannot
  // smuggle in arbitrary keys. That means anything new has to be added here
  // explicitly -- and a worker-written log round-tripped through export and
  // re-import would otherwise arrive with its quality and raw reads silently
  // dropped, which looks exactly like the worker never recorded them.
  return {
    matchKey: String(obj.matchKey),
    eventKey: String(obj.eventKey || fallbackEventKey),
    source: String(obj.source || 'imported JSON'),
    samples,
    createdAt: Number(obj.createdAt) || Date.now(),
    ...(obj.quality ? { quality: obj.quality as CvQuality } : {}),
    ...(typeof obj.flagged === 'boolean' ? { flagged: obj.flagged } : {}),
    ...(obj.video && typeof obj.video.url === 'string' && typeof obj.video.timeBase === 'string' &&
        Number.isFinite(obj.video.greenFlagAt) ? { video: { url: obj.video.url, timeBase: obj.video.timeBase, greenFlagAt: obj.video.greenFlagAt } } : {}),
    ...(Array.isArray(obj.rawReads) ? { rawReads: obj.rawReads as CvRawRead[] } : {}),
  };
}
