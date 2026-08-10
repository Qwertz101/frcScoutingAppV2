import { ScoutingData, Scouter } from '../types';
import { uuidv4 } from '../utils/uuid';
import { migrateLocalToServer, upsertPitData, uploadPitImage } from './syncService';

const STORAGE_KEYS = {
  SCOUTING_DATA: 'frc-scouting-data',
  PIT_DATA: 'frc-pit-data',
  PIT_IMAGES: 'frc-pit-images',
  TEAMS: 'frc-teams',
  SCOUTERS: 'frc-scouters',
  MATCHES: 'frc-matches',
  SELECTED_EVENT: 'frc-selected-event',
  PENDING_SCOUTING: 'frc-pending-scouting',
  CLIENT_ID: 'frc-client-id',
};

export class DataService {
  // ensure a client id exists for dedup/traceability
  static getClientId(): string {
    let id = localStorage.getItem(STORAGE_KEYS.CLIENT_ID);
    if (!id) {
      id = uuidv4();
      localStorage.setItem(STORAGE_KEYS.CLIENT_ID, id);
    }
    return id;
  }

  static saveScoutingData(data: ScoutingData): void {
    try {
      const existingData = this.getScoutingData();

      // ensure record has an id and client info
      const record = {
        ...data,
        id: data.id || uuidv4(),
        clientId: (data as any).clientId || this.getClientId(),
        createdAt: (data as any).createdAt || Date.now(),
        synced: false,
      } as any;

      const updatedData = [...existingData, record];
      localStorage.setItem(STORAGE_KEYS.SCOUTING_DATA, JSON.stringify(updatedData));

      // add to pending queue
      const pending = this.getPendingScouting();
      pending.push(record.id);
      localStorage.setItem(STORAGE_KEYS.PENDING_SCOUTING, JSON.stringify(pending));
      // Attempt a background sync when online so saves propagate to server quickly
      try {
        // don't await - fire-and-forget
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.syncData();
      } catch (e) {
        // ignore sync errors here
      }
    } catch (e) {
      // ignore write errors
      // eslint-disable-next-line no-console
      console.error('Failed saving scouting data', e);
    }
  }

  static getScoutingData(): ScoutingData[] {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.SCOUTING_DATA);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  static saveScouters(scouters: Scouter[]): void {
    const now = Date.now();
    const stamped = scouters.map(s => ({ ...s, updatedAt: s.updatedAt || now }));
    localStorage.setItem(STORAGE_KEYS.SCOUTERS, JSON.stringify(stamped));
    // notify other listeners in this window (and other tabs via storage event)
    try {
      window.dispatchEvent(new CustomEvent('local-storage', { detail: { key: STORAGE_KEYS.SCOUTERS, value: stamped } }));
    } catch (e) {
      // ignore environments that don't support CustomEvent
    }
  }

  static getScouters(): Scouter[] {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.SCOUTERS);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  static saveMatches(matches: any[]): void {
    const now = Date.now();
    const stamped = matches.map((m: any) => ({ ...m, updatedAt: m.updatedAt || now }));
    localStorage.setItem(STORAGE_KEYS.MATCHES, JSON.stringify(stamped));
  }

  /**
   * The event a match's own `key` says it belongs to, per the FRC/TBA
   * convention: `{eventKey}_{compLevel}{matchNumber}`, e.g.
   * `2026caven_qm1`, `2026caven_sf1m1`, `2026caven_f1m1`.
   *
   * This is the ONLY event_key any push to the server should ever use. A
   * match object's own `event_key` field, or "whichever event is currently
   * selected," are both just state that can go stale — a failed TBA fetch,
   * a leftover local cache from a previous event, a background sync racing
   * a UI action. The key itself cannot go stale: it was correct the moment
   * the match was created and never changes. Deriving from it, rather than
   * trusting a separately-stored field, is what makes it structurally
   * impossible to relabel one event's schedule as another's on push — see
   * the corruption this fixed: 87 of Ventura's matches spent time on the
   * server tagged event_key='2026cagle' (Glendale) because a push trusted a
   * stale `event_key`/selected-event value instead of the key itself.
   */
  static deriveEventKeyFromMatchKey(key: unknown): string | null {
    if (typeof key !== 'string') return null;
    const idx = key.indexOf('_');
    return idx > 0 ? key.slice(0, idx) : null;
  }

  /**
   * True if a match belongs to the given event.
   *
   * Prefers the FRC/TBA match-key convention (`{eventKey}_qm1`, ...) over
   * the stored `event_key` field, for the same reason `deriveEventKeyFromMatchKey`
   * does: the field can go stale, the key cannot. Falls back to `event_key`
   * only when the key doesn't parse (unexpected shape).
   */
  static matchBelongsToEvent(match: any, eventKey: string): boolean {
    if (!match || !eventKey) return false;
    const derived = this.deriveEventKeyFromMatchKey(match.key);
    if (derived) return derived === eventKey;
    // Key didn't parse (unexpected shape) — fall back to the stored field.
    return !!match.event_key && match.event_key === eventKey;
  }

  /**
   * Matches for the currently selected event.
   *
   * The server's `matches` table holds every event any device has ever
   * synced — one team's Supabase project sees every regional they've
   * scouted, in one table. Filtering here, at the single place almost every
   * screen reads matches through, is what keeps Field Ranking, Match List,
   * Pit Scouting, etc. from mixing this week's teams with last month's.
   *
   * Pass `{ allEvents: true }` for the few places that genuinely want the
   * whole local cache (e.g. an admin tool auditing all synced events).
   */
  static getMatches(opts?: { allEvents?: boolean }): any[] {
    let all: any[];
    try {
      const data = localStorage.getItem(STORAGE_KEYS.MATCHES);
      all = data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
    if (opts?.allEvents) return all;

    const eventKey = this.getSelectedEvent();
    if (!eventKey) return all;
    return all.filter((m: any) => this.matchBelongsToEvent(m, eventKey));
  }

  // Manual team helpers (for when TBA match list isn't available)
  static addTeam(teamKey: string, name?: string): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.TEAMS) || '{}';
      const obj = JSON.parse(raw || '{}');
      obj[teamKey] = { ...(obj[teamKey] || {}), name: name || obj[teamKey]?.name || '', updatedAt: Date.now() };
      localStorage.setItem(STORAGE_KEYS.TEAMS, JSON.stringify(obj));
      // attempt to create a corresponding pit_data row on the server so other devices
      // can discover this team even if matches are not available.
      try {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        upsertPitData(teamKey, {});
      } catch (e) {
        // ignore server errors
      }
    } catch (e) {
      // ignore
    }
  }

  static getTeams(): Array<{ teamKey: string; name?: string }> {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.TEAMS) || '{}';
      const obj = JSON.parse(raw || '{}');
      return Object.keys(obj).map(k => ({ teamKey: k, name: obj[k].name }));
    } catch (e) {
      return [];
    }
  }

  static removeTeam(teamKey: string): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.TEAMS) || '{}';
      const obj = JSON.parse(raw || '{}');
      if (obj[teamKey]) {
        delete obj[teamKey];
        localStorage.setItem(STORAGE_KEYS.TEAMS, JSON.stringify(obj));
      }
    } catch (e) {
      // ignore
    }
  }

  static setSelectedEvent(eventKey: string): void {
    localStorage.setItem(STORAGE_KEYS.SELECTED_EVENT, eventKey);
  }

  static getSelectedEvent(): string | null {
    return localStorage.getItem(STORAGE_KEYS.SELECTED_EVENT);
  }

  static clearMatches(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.MATCHES);
      localStorage.removeItem(STORAGE_KEYS.SELECTED_EVENT);
    } catch {
      // ignore
    }
  }

  // PIT scouting helpers
  static savePitData(teamKey: string, data: any): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.PIT_DATA) || '{}';
      const obj = JSON.parse(raw || '{}');
      obj[teamKey] = { ...(obj[teamKey] || {}), ...data, updatedAt: Date.now() };
      localStorage.setItem(STORAGE_KEYS.PIT_DATA, JSON.stringify(obj));
      // attempt to persist to server (fire-and-forget)
      try {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        upsertPitData(teamKey, obj[teamKey]);
      } catch (e) {
        // ignore server errors here
      }
    } catch (e) {
      // ignore
    }
  }

  static getPitData(teamKey?: string): any {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.PIT_DATA) || '{}';
      const obj = JSON.parse(raw || '{}');
      if (teamKey) return obj[teamKey] || null;
      return obj;
    } catch (e) {
      return teamKey ? null : {};
    }
  }

  // PIT image helpers - store data URLs (small sets) per team
  static savePitImages(teamKey: string, images: string[]): void {
    try {
      // Do NOT persist images to localStorage. Instead, attempt to upload any
      // provided data-URL images immediately and upsert the pit_data row with
      // the resulting public URLs. This prevents stale local copies from
      // appearing after server-side clears.
      (async () => {
        try {
          const imgs: string[] = images.slice();
          for (let i = 0; i < imgs.length; i++) {
            const v = imgs[i];
            if (typeof v === 'string' && v.startsWith('data:')) {
              try {
                // eslint-disable-next-line no-console
                console.debug('savePitImages: uploading image', i, 'for', teamKey);
                const url = await uploadPitImage(teamKey, v);
                if (url) {
                  imgs[i] = url;
                  // eslint-disable-next-line no-console
                  console.debug('savePitImages: upload succeeded', i, url);
                } else {
                  // eslint-disable-next-line no-console
                  console.warn('savePitImages: upload returned no URL for', teamKey, i);
                }
              } catch (e) {
                // eslint-disable-next-line no-console
                console.error('savePitImages: upload failed for', teamKey, i, e);
                // leave the original entry so we don't lose it client-side
              }
            }
          }

          // persist images in the pit_data payload on the server (fire-and-forget)
          try {
            const pit = DataService.getPitData(teamKey) || {};
            pit.images = imgs;
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            upsertPitData(teamKey, pit);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error('savePitImages: failed to upsert pit_data for', teamKey, e);
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('savePitImages: unexpected error in uploader for', teamKey, e);
        }
      })();
    } catch (e) {
      // ignore synchronous errors
    }
  }

  static getPitImages(teamKey: string): string[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.PIT_IMAGES) || '{}';
      const obj = JSON.parse(raw || '{}');
      return (obj[teamKey] && obj[teamKey].images) || [];
    } catch (e) {
      return [];
    }
  }

  static deletePitImage(teamKey: string, index: number): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.PIT_IMAGES) || '{}';
      const obj = JSON.parse(raw || '{}');
      const arr = (obj[teamKey] && obj[teamKey].images) || [];
      if (index >= 0 && index < arr.length) {
        arr.splice(index, 1);
        obj[teamKey] = { images: arr, updatedAt: Date.now() };
        localStorage.setItem(STORAGE_KEYS.PIT_IMAGES, JSON.stringify(obj));
      }
    } catch (e) {
      // ignore
    }
  }

  static clearPitData(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.PIT_DATA);
    } catch (e) {
      // ignore
    }
  }

  static clearPitImages(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.PIT_IMAGES);
    } catch (e) {
      // ignore
    }
  }

  static clearScoutingData(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.SCOUTING_DATA);
    } catch {
      // ignore
    }
  }

  static isOnline(): boolean {
    return navigator.onLine;
  }

  // Pending queue helpers
  static getPendingScouting(): string[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.PENDING_SCOUTING);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  static setPendingScouting(pending: string[]): void {
    try {
      localStorage.setItem(STORAGE_KEYS.PENDING_SCOUTING, JSON.stringify(pending));
    } catch {
      // ignore
    }
  }

  static markScoutingSynced(ids: string[]): void {
    try {
      const data = this.getScoutingData() as any[];
      const updated = data.map(d => (ids.includes(d.id) ? { ...d, synced: true, syncedAt: Date.now() } : d));
      localStorage.setItem(STORAGE_KEYS.SCOUTING_DATA, JSON.stringify(updated));
      // remove from pending queue
      const pending = this.getPendingScouting().filter(id => !ids.includes(id));
      localStorage.setItem(STORAGE_KEYS.PENDING_SCOUTING, JSON.stringify(pending));
    } catch (e) {
      // ignore
    }
  }

  // Replace the entire scouting data array (used for id-migration fixes)
  static replaceScoutingData(records: any[]): void {
    try {
      localStorage.setItem(STORAGE_KEYS.SCOUTING_DATA, JSON.stringify(records));
    } catch {
      // ignore
    }
  }

  static updateScoutingData(record: any): void {
    try {
      const data = this.getScoutingData() as any[];
      let found = false;
      const updated = data.map(d => {
        if (d.id === record.id) {
          found = true;
          return { ...d, ...record, synced: false, updatedAt: Date.now() };
        }
        return d;
      });
      if (!found) {
        // insert new local record (server-origin or first-time edit)
        const rec = { ...record, id: record.id || uuidv4(), clientId: record.clientId || this.getClientId(), createdAt: record.createdAt || Date.now(), synced: false, updatedAt: Date.now() };
        updated.push(rec);
      }
      localStorage.setItem(STORAGE_KEYS.SCOUTING_DATA, JSON.stringify(updated));
      // ensure this id is in the pending queue so syncService will push the update
      try {
        const pending = this.getPendingScouting();
        const pid = record.id || (found ? record.id : updated[updated.length - 1].id);
        if (!pending.includes(pid)) {
          pending.push(pid);
          localStorage.setItem(STORAGE_KEYS.PENDING_SCOUTING, JSON.stringify(pending));
          // notify other tabs/listeners
          try {
            window.dispatchEvent(new CustomEvent('local-storage', { detail: { key: STORAGE_KEYS.PENDING_SCOUTING, value: pending } }));
          } catch (e) {
            // ignore
          }
        }
      } catch (e) {
        // ignore pending queue errors
      }
    } catch (e) {
      // ignore
      // eslint-disable-next-line no-console
      console.error('Failed updating scouting data', e);
    }
  }

  static clearAllPending(): void {
    try {
      localStorage.removeItem(STORAGE_KEYS.PENDING_SCOUTING);
    } catch {}
  }

  static async syncData(): Promise<void> {
    if (this.isOnline()) {
      await migrateLocalToServer();
    }
  }

  // Migration scaffold: keep a numeric data version in localStorage and apply
  // idempotent migrations when the app loads.
  static async migrateIfNeeded(): Promise<void> {
  const SCHEMA_KEY = 'frc-data-version';
    const vRaw = localStorage.getItem(SCHEMA_KEY);
    const v = vRaw ? Number(vRaw) : 0;
    try {
      if (v < 1) {
        // migration 0 -> 1: convert endgame.climb 'deep' -> 'high'
        const rows = this.getScoutingData();
        const updated = rows.map(r => {
          try {
            const climb = r && r.endgame ? (r.endgame as any).climb : undefined;
            if (climb === 'deep') {
              return { ...r, endgame: { ...(r.endgame || {}), climb: 'high' } };
            }
          } catch (e) {}
          return r;
        });
        this.replaceScoutingData(updated);
        localStorage.setItem(SCHEMA_KEY, '1');
      }

      if (v < 2) {
        // migration 1 -> 2: coerce boolean net/prosser fields to numeric 0/1 and drop legacy auto.prosser
        const rows = this.getScoutingData();
        const updated = rows.map(r => {
          try {
            const auto = (r.auto || {}) as any;
            const teleop = (r.teleop || {}) as any;
            const coercedAutoNet = typeof auto.net === 'number' ? auto.net : (auto.net ? 1 : 0);
            const coercedTeleNet = typeof teleop.net === 'number' ? teleop.net : (teleop.net ? 1 : 0);
            const coercedTelePros = typeof teleop.prosser === 'number' ? teleop.prosser : (teleop.prosser ? 1 : 0);
            return { ...r, auto: { ...auto, net: coercedAutoNet }, teleop: { ...teleop, net: coercedTeleNet, prosser: coercedTelePros } };
          } catch (e) { return r; }
        });
        this.replaceScoutingData(updated);
        localStorage.setItem(SCHEMA_KEY, '2');
      }

      // future migrations go here
    } catch (e) {
      // if migration fails, don't block app; leave version as-is for investigation
      // eslint-disable-next-line no-console
      console.error('Migration failed', e);
    }
  }

  // Clean and normalize local data: remove malformed rows, coerce field types,
  // normalize enums, and ensure pending queue references existing records.
  // Returns a summary and the raw backup data (so caller can offer a download).
  static async cleanAndNormalize(): Promise<{ removed: number; fixed: number; pendingRemoved: number; backup: string }> {
    const SCOUT_KEY = STORAGE_KEYS.SCOUTING_DATA;
    const PENDING_KEY = STORAGE_KEYS.PENDING_SCOUTING;
    const raw = localStorage.getItem(SCOUT_KEY) || '[]';
    const pendingRaw = localStorage.getItem(PENDING_KEY) || '[]';
    const backupObj = { scouting: JSON.parse(raw || '[]'), pending: JSON.parse(pendingRaw || '[]') };

    let removed = 0;
    let fixed = 0;
    let pendingRemoved = 0;

    try {
      const rows = backupObj.scouting as any[];
      const cleaned: any[] = [];
      for (const r of rows) {
        // Basic validation: must have id, teamKey, matchKey, scouter
        if (!r || !r.id || !r.teamKey || !r.matchKey || !r.scouter) {
          removed += 1;
          continue;
        }

        let modified = false;
        const out = { ...r } as any;

        // normalize climb
        try {
          const climb = out.endgame?.climb;
          if (climb === 'deep') {
            out.endgame = { ...(out.endgame || {}), climb: 'high' };
            modified = true;
          }
        } catch (e) {}

        // coerce nets/prosser to numbers
        try {
          out.auto = out.auto || {};
          out.teleop = out.teleop || {};
          const autoNet = out.auto.net;
          if (typeof autoNet !== 'number') {
            out.auto.net = autoNet ? 1 : 0;
            modified = true;
          }
          const teleNet = out.teleop.net;
          if (typeof teleNet !== 'number') {
            out.teleop.net = teleNet ? 1 : 0;
            modified = true;
          }
          const telePros = out.teleop.prosser;
          if (typeof telePros !== 'number') {
            out.teleop.prosser = telePros ? 1 : 0;
            modified = true;
          }
        } catch (e) {}

        if (modified) fixed += 1;
        cleaned.push(out);
      }

      // write back cleaned rows
      localStorage.setItem(SCOUT_KEY, JSON.stringify(cleaned));

      // fix pending queue: remove ids that are not in cleaned rows
      try {
        const pending = JSON.parse(pendingRaw || '[]') as string[];
        const validIds = new Set(cleaned.map(r => r.id));
        const newPending = pending.filter(id => {
          const keep = validIds.has(id);
          if (!keep) pendingRemoved += 1;
          return keep;
        });
        localStorage.setItem(PENDING_KEY, JSON.stringify(newPending));
      } catch (e) {
        // ignore
      }
    } catch (e) {
      // if anything goes wrong, preserve original data in localStorage (do not wipe)
      // eslint-disable-next-line no-console
      console.error('cleanAndNormalize failed', e);
      return { removed: 0, fixed: 0, pendingRemoved: 0, backup: JSON.stringify(backupObj) };
    }

    return { removed, fixed, pendingRemoved, backup: JSON.stringify(backupObj) };
  }
}