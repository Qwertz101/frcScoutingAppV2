import { CvMatchLog, TimelineScoutingData } from '../types';
import { uuidv4 } from '../utils/uuid';
import supabase from './supabaseClient';
import { DataService } from './dataService';

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

  void pushTimelines();
  return full;
}

export function findTimeline(matchKey: string, teamKey: string, scouter: string) {
  return getTimelines().find(
    (t) => t.matchKey === matchKey && t.teamKey === teamKey && t.scouter === scouter
  );
}

/** Push any unsynced timelines. Safe to call repeatedly; no-ops when offline. */
export async function pushTimelines(): Promise<{ pushed: number; error?: string }> {
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
    const { error } = await supabase.from('timeline_records').upsert(rows, { onConflict: 'id' });
    if (error) throw error;
    writeJson(KEYS.PENDING_TIMELINES, []);
    return { pushed: rows.length };
  } catch (e: any) {
    console.warn('bpsStore: timeline push failed, will retry', e);
    return { pushed: 0, error: String(e?.message || e) };
  }
}

/** Pull server timelines and merge them over the local copy. */
export async function fetchTimelines(): Promise<TimelineScoutingData[]> {
  if (!supabase) return getTimelines();

  const { data, error } = await supabase
    .from('timeline_records')
    .select('*')
    .order('timestamp', { ascending: false });
  if (error) throw error;

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
  const local = getTimelines().filter((t) => pending.has(t.id));
  const merged = new Map<string, TimelineScoutingData>();
  for (const t of server) merged.set(t.id, t);
  for (const t of local) merged.set(t.id, t);

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
  void pushCvLogs();
}

export async function pushCvLogs(): Promise<{ pushed: number; error?: string }> {
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
    const { error } = await supabase.from('cv_logs').upsert(rows, { onConflict: 'match_key' });
    if (error) throw error;
    writeJson(KEYS.PENDING_CV, []);
    return { pushed: rows.length };
  } catch (e: any) {
    console.warn('bpsStore: CV log push failed, will retry', e);
    return { pushed: 0, error: String(e?.message || e) };
  }
}

export async function fetchCvLogs(): Promise<CvMatchLog[]> {
  if (!supabase) return getCvLogs();

  const { data, error } = await supabase.from('cv_logs').select('*');
  if (error) throw error;

  const server: CvMatchLog[] = (data ?? []).map((r: any) => ({
    matchKey: r.match_key,
    eventKey: r.event_key,
    source: r.source ?? 'unknown',
    samples: r.samples ?? [],
    createdAt: r.created_at ? Date.parse(r.created_at) : Date.now(),
    updatedAt: r.updated_at ? Date.parse(r.updated_at) : undefined,
    deletedAt: r.deleted_at ? Date.parse(r.deleted_at) : null,
  }));

  const pending = new Set(readJson<string[]>(KEYS.PENDING_CV, []));
  const local = readJson<CvMatchLog[]>(KEYS.CV_LOGS, []).filter((l) => pending.has(l.matchKey));
  const merged = new Map<string, CvMatchLog>();
  for (const l of server) merged.set(l.matchKey, l);
  for (const l of local) merged.set(l.matchKey, l);

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
      phase: s.phase === 'auto' ? 'auto' : 'teleop',
      blue: Number(s.blue) || 0,
      red: Number(s.red) || 0,
      db: Number(s.db) || 0,
      dr: Number(s.dr) || 0,
    };
  });

  return {
    matchKey: String(obj.matchKey),
    eventKey: String(obj.eventKey || fallbackEventKey),
    source: String(obj.source || 'imported JSON'),
    samples,
    createdAt: Number(obj.createdAt) || Date.now(),
  };
}
