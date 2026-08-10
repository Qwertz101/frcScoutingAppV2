import { DataService } from './dataService';
import supabase, { getSupabaseInfo } from './supabaseClient';
import { uuidv4 } from '../utils/uuid';

function getSupabaseClient() {
  return supabase;
}

// utility: exponential backoff
function wait(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

async function sendBatchToServer(records: any[]) {
  const client = getSupabaseClient();
  if (!client) throw new Error('no supabase client');
  // try upsert with supabase-js
  try {
    // log summary for debugging
    // eslint-disable-next-line no-console
    console.debug('SyncService: sending batch to scouting_records, count=', records.length);
    const { error, data } = await client.from('scouting_records').upsert(records, { onConflict: 'id' });
    if (error) {
      // eslint-disable-next-line no-console
      console.error('SyncService: upsert error for scouting_records', { error, records });
      throw error;
    }
    // eslint-disable-next-line no-console
    const rows = Array.isArray(data) ? (data as any[]).length : 0;
    console.debug('SyncService: upsert succeeded, rows=', rows);
    return { data };
  } catch (err) {
    // bubble up
    throw err;
  }
}

// Resolve a usable URL for a storage object: prefer public URL, verify it returns OK,
// otherwise attempt to create a short-lived signed URL as a fallback.
async function resolvePublicUrl(client: any, bucket: string, path: string) {
  try {
    // getPublicUrl is a synchronous URL builder — no network request needed.
    // Return it directly for public buckets; CORS blocks HEAD validation so we skip it.
    const publicRes: any = client.storage.from(bucket).getPublicUrl(path);
    const publicUrl = publicRes && publicRes.data ? (publicRes.data.publicUrl || publicRes.data.publicURL) : (publicRes?.publicUrl || publicRes?.publicURL);
    if (publicUrl) return publicUrl;

    // Fallback: generate a signed URL for private buckets (1 hour expiry)
    try {
      const signedRes: any = await client.storage.from(bucket).createSignedUrl(path, 3600);
      const signedUrl = signedRes && signedRes.data ? (signedRes.data.signedUrl || signedRes.data.signedURL) : signedRes?.signedUrl || signedRes?.signedURL;
      if (signedUrl) return signedUrl;
    } catch (e) {
      // ignore
    }

    return null;
  } catch (err) {
    return null;
  }
}

async function pushPendingToServer(options?: { batchSize?: number; maxRetries?: number }): Promise<number> {
  const batchSize = options?.batchSize || 50;
  if (_pushLock) {
    // eslint-disable-next-line no-console
    console.debug('SyncService: pushPendingToServer skipped because another push is running');
    return 0;
  }
  _pushLock = true;
  try {
    if (!_pushTimerActive) {
      try { console.time('sync:pushPendingToServer'); _pushTimerActive = true; } catch (e) {}
    }
    const maxRetries = options?.maxRetries || 5;

    const pending = DataService.getPendingScouting();
    if (!pending || pending.length === 0) return 0;

    const all = DataService.getScoutingData() as any[];
    const records = all.filter(r => pending.includes(r.id));
    if (records.length === 0) return 0;

    // Normalize ids: Supabase expects UUIDs for primary keys. If any local record uses a non-UUID id
    // (for example, composed of match/team/timestamp), generate a proper UUID and persist the change
    // so the pending queue and local storage reference the new UUIDs.
    let mutated = false;
    const idMap: Record<string, string> = {};
    const newAll = all.map((r: any) => {
      const isUuidLike = typeof r.id === 'string' && r.id.length === 36 && r.id.includes('-');
      if (!isUuidLike) {
        const newId = uuidv4();
        idMap[r.id] = newId;
        mutated = true;
        return { ...r, id: newId };
      }
      return r;
    });
    if (mutated) {
      // persist updated records and update pending queue
      DataService.replaceScoutingData(newAll);
      const newPending = DataService.getPendingScouting().map((pid: string) => idMap[pid] || pid);
      DataService.setPendingScouting(newPending);
      // refresh local pointers
      // eslint-disable-next-line no-console
      console.debug('SyncService: normalized non-UUID ids for pending scouting records', { idMap });
      // recalc records to send
      const refreshedAll = newAll;
      // eslint-disable-next-line no-shadow
      const refreshedRecords = refreshedAll.filter((r: any) => newPending.includes(r.id));
      // override records variable for subsequent processing
      // @ts-ignore
      records.length = 0; // clear
      // @ts-ignore
      records.push(...refreshedRecords);
    }

    const client = getSupabaseClient();
    if (!client) {
      throw new Error('Supabase client not configured; cannot push pending scouting.');
    }

    // batch and retry
    let totalSynced = 0;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      // TEMP LOG: per-batch timing (unique label to avoid collisions)
      const batchLabel = `sync:pushBatch-${i}-${Date.now()}`;
      try { console.time(batchLabel); } catch (e) {}
      // map to server shape
        const payload = batch.map(r => {
        // ensure match-level climb is persisted inside payload.endgame.climb so server rows
        // have a canonical place for match climb regardless of local field shape
        const endgame = Object.assign({}, r.endgame || {});
        if (!endgame.climb && r.matchClimbed) {
          endgame.climb = r.matchClimbed;
        }
        return {
          id: r.id,
          match_key: r.matchKey,
          team_key: r.teamKey,
          scouter_name: r.scouter,
          alliance: r.alliance,
          position: r.position,
          payload: {
            auto: r.auto,
            teleop: r.teleop,
            endgame,
            defense: r.defense,
            // Provenance for rows reconstructed by the stats-CSV importer.
            // Must round-trip so the UI can keep labelling them as synthetic.
            ...(r.synthetic
              ? { synthetic: true, syntheticSource: r.syntheticSource }
              : {}),
          },
          client_id: r.clientId,
          timestamp: new Date(r.timestamp || r.createdAt).toISOString(),
        };
      });

      let attempt = 0;
      while (attempt <= maxRetries) {
        try {
          await sendBatchToServer(payload);
          const ids = batch.map(r => r.id);
          DataService.markScoutingSynced(ids);
          totalSynced += ids.length;
          try { console.timeEnd(batchLabel); } catch (e) {}
          // continue to next batch
          break;
        } catch (err) {
          attempt++;
          const backoff = Math.pow(2, attempt) * 500; // exponential backoff
          console.warn(`SyncService: batch sync failed, attempt ${attempt}, retrying in ${backoff}ms`, err);
          await wait(backoff);
          if (attempt > maxRetries) {
            try { console.timeEnd(batchLabel); } catch (e) {}
            throw new Error('SyncService: max retries reached for batch, leaving pending');
          }
        }
      }
    }
    return totalSynced;
  } finally {
    try { if (_pushTimerActive) { console.timeEnd('sync:pushPendingToServer'); _pushTimerActive = false; } } catch (e) {}
    _pushLock = false;
  }
}
// stray extra brace above removed

// migration: push pending records then pull authoritative scouters & matches
// Use a promise-based in-flight sync to coalesce concurrent requests
let _inFlightSync: Promise<any> | null = null;
let _inFlightFullRefresh: Promise<any> | null = null;

let _pushLock = false;
let _pushTimerActive = false;
let _fetchScoutingLock = false;

async function _migrateLocalToServerBody() {
  console.time('sync:migrateLocalToServer');
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase client not configured; cannot migrate local data.');
  }

  let pendingSynced = 0;
  let scoutersUpserted = 0;
  let matchesUpserted = 0;

  // 1) push pending scouting
  try {
    pendingSynced = await pushPendingToServer({ batchSize: 100, maxRetries: 6 });
    // continue
  } catch (e) {
    // bubble up push errors — UI may want to display them
    throw e;
  }

  // If we pushed any pending scouting, notify interested listeners that server state changed
  try {
    if (pendingSynced && pendingSynced > 0) {
      notifyServerScoutingUpdated();
    }
  } catch (e) {
    // ignore notifier failures
  }

  // 2) pull scouters
  try {
    const { data: scouters, error: sErr } = await client.from('scouters').select('*');
    if (!sErr && scouters) {
      // Merge server scouters with local scouters using last-write-wins merge policy.
      try {
        const local = DataService.getScouters();
        const localMap: Record<string, any> = {};
        local.forEach((s: any) => { if (s && s.id) localMap[s.id] = s; });

        const serverMap: Record<string, any> = {};
        scouters.forEach((s: any) => { if (s && s.id) serverMap[s.id] = s; });

        const allIds = new Set<string>([...Object.keys(localMap), ...Object.keys(serverMap)]);
        const toUpsert: any[] = [];
        const merged: any[] = [];

        for (const id of allIds) {
          const l = localMap[id];
          const s = serverMap[id];

          const serverUpdated = s && s.updated_at ? Date.parse(s.updated_at) : 0;
          const serverDeleted = s && s.deleted_at ? Date.parse(s.deleted_at) : null;
          const serverDeletedTs = serverDeleted ?? 0;
          const localUpdated = l && l.updatedAt ? l.updatedAt : 0;
          const localDeleted = l && l.deletedAt ? l.deletedAt : null;
          const localDeletedTs = localDeleted ?? 0;

          if (s && l) {
            // both exist: compare timestamps
            if (localDeletedTs > 0 && (serverDeletedTs === 0 || localDeletedTs > serverUpdated)) {
              // local has a newer deletion -> push delete to server
              toUpsert.push({
                id,
                name: l.name,
                alliance: l.alliance,
                position: l.position,
                is_remote: l.isRemote ?? false,
                deleted_at: new Date(localDeleted).toISOString(),
              });
              merged.push({ ...l });
            } else if (serverDeletedTs > 0 && (localDeletedTs === 0 || serverDeletedTs > localUpdated)) {
              // server has a newer deletion -> accept server row
              merged.push({
                id: s.id,
                name: s.name,
                alliance: s.alliance,
                position: s.position,
                isRemote: s.is_remote ?? s.isRemote ?? false,
                updatedAt: serverUpdated,
                deletedAt: s.deleted_at ? Date.parse(s.deleted_at) : null,
              });
            } else {
              // no deletion conflict: normal update by updatedAt
              if (localUpdated > serverUpdated) {
                // local wins -> push to server
                toUpsert.push({
                  id,
                  name: l.name,
                  alliance: l.alliance,
                  position: l.position,
                  is_remote: l.isRemote ?? false,
                  deleted_at: l.deletedAt ? new Date(l.deletedAt).toISOString() : null,
                });
                merged.push({ ...l });
              } else {
                // server wins -> accept server
                merged.push({
                  id: s.id,
                  name: s.name,
                  alliance: s.alliance,
                  position: s.position,
                  isRemote: s.is_remote ?? s.isRemote ?? false,
                  updatedAt: serverUpdated,
                  deletedAt: s.deleted_at ? Date.parse(s.deleted_at) : null,
                });
              }
            }
          } else if (l && !s) {
            // only local -> create on server
            // ensure id is a valid UUID (Supabase expects uuid primary keys)
            let upsertId = id;
            const isUuidLike = typeof upsertId === 'string' && upsertId.length === 36 && upsertId.includes('-');
            if (!isUuidLike) {
              // generate a UUID and replace the local id so future devices/tabs see the same id
              // dynamic import to avoid circular dependencies
              const newId = uuidv4();
              upsertId = newId;
              // update localMap so merged state includes new id
              const updatedLocal = { ...l, id: newId };
              localMap[newId] = updatedLocal;
              delete localMap[id];
              merged.push({ ...updatedLocal });
              toUpsert.push({
                id: upsertId,
                name: updatedLocal.name,
                alliance: updatedLocal.alliance,
                position: updatedLocal.position,
                is_remote: updatedLocal.isRemote ?? false,
                deleted_at: updatedLocal.deletedAt ? new Date(updatedLocal.deletedAt).toISOString() : null,
              });
              // continue to next id (we've already queued upsert for the replaced item)
              continue;
            }

            toUpsert.push({
              id: upsertId,
              name: l.name,
              alliance: l.alliance,
              position: l.position,
              is_remote: l.isRemote ?? false,
              deleted_at: l.deletedAt ? new Date(l.deletedAt).toISOString() : null,
            });
            merged.push({ ...l });
          } else if (s && !l) {
            // only server -> accept server
            merged.push({
              id: s.id,
              name: s.name,
              alliance: s.alliance,
              position: s.position,
              isRemote: s.is_remote ?? s.isRemote ?? false,
              updatedAt: serverUpdated,
              deletedAt: s.deleted_at ? Date.parse(s.deleted_at) : null,
            });
          }
        }

        // If we have upserts to send, push them and then re-pull authoritative server rows
  // scoutersUpserted is tracked in outer scope
        if (toUpsert.length > 0) {
          try {
            const { error: upErr } = await client.from('scouters').upsert(toUpsert, { onConflict: 'id' });
            if (upErr) {
              console.error('SyncService: error upserting scouters', upErr);
              // persist merged local view
              DataService.saveScouters(merged as any);
              // reflect that merged local view contains these rows
              scoutersUpserted = merged.length;
            } else {
              // refresh server rows for authoritative timestamps
              const { data: refreshed, error: refErr } = await client.from('scouters').select('*');
              if (!refErr && refreshed) {
                const mapped = refreshed.map((s: any) => ({
                  id: s.id,
                  name: s.name,
                  alliance: s.alliance,
                  position: s.position,
                  isRemote: s.is_remote ?? s.isRemote ?? false,
                  updatedAt: s.updated_at ? Date.parse(s.updated_at) : Date.now(),
                  deletedAt: s.deleted_at ? Date.parse(s.deleted_at) : null,
                }));
                DataService.saveScouters(mapped as any);
                scoutersUpserted = mapped.length;
              } else if (refErr) {
                console.error('SyncService: failed to refresh scouters after upsert', refErr);
                // fallback to merged local state
                DataService.saveScouters(merged as any);
                scoutersUpserted = merged.length;
              }
            }
          } catch (e) {
            console.error('SyncService: exception upserting scouters', e);
            DataService.saveScouters(merged as any);
            scoutersUpserted = merged.length;
          }
        } else {
          // no upserts necessary, persist merged local view
          DataService.saveScouters(merged as any);
          scoutersUpserted = merged.length;
        }
      } catch (e) {
        console.error('SyncService: error merging scouters', e);
        // as a fallback, write server-provided scouters
        DataService.saveScouters(scouters as any);
      }
    } else if (sErr) {
      console.error('SyncService: failed to pull scouters', sErr);
    }
  } catch (e) {
    throw e;
  }

  // 3) pull matches
  try {
    // Scope the pull to the currently selected event: the server's `matches`
    // table accumulates every event any device has ever synced, and pulling
    // it unfiltered is what used to make a freshly-loaded event's Scout
    // Workspace show teams from whatever event was scouted last. Matches for
    // OTHER events already in local storage are preserved untouched below
    // (via `localOther`) rather than dropped.
    const eventKey = DataService.getSelectedEvent();
    const matchesQuery = eventKey
      ? client.from('matches').select('*').eq('event_key', eventKey)
      : client.from('matches').select('*');
    const { data: matches, error: mErr } = await matchesQuery;
    if (!mErr && matches) {
      const localAll = DataService.getMatches({ allEvents: true });
      const localOther = eventKey
        ? localAll.filter((m: any) => !DataService.matchBelongsToEvent(m, eventKey))
        : [];
      // Every DataService.saveMatches(...) below (including the catch) must
      // include localOther so this pass never erases other events' already-
      // synced matches. Declared here, above the try, so the catch can use it.
      const saveMerged = (currentEventRows: any[]) =>
        DataService.saveMatches([...localOther, ...currentEventRows] as any);

      // Merge matches by key using last-write-wins on updated_at / updatedAt
      try {
        const local = eventKey
          ? localAll.filter((m: any) => DataService.matchBelongsToEvent(m, eventKey))
          : localAll;
        const localMap: Record<string, any> = {};
        local.forEach((m: any) => { if (m && m.key) localMap[m.key] = m; });

        const serverMap: Record<string, any> = {};
        matches.forEach((m: any) => { if (m && m.key) serverMap[m.key] = m; });

        const allKeys = new Set<string>([...Object.keys(localMap), ...Object.keys(serverMap)]);
        const toUpsert: any[] = [];
        const merged: any[] = [];

        for (const key of allKeys) {
          const l = localMap[key];
          const s = serverMap[key];
          const serverUpdated = s && s.updated_at ? Date.parse(s.updated_at) : 0;
          const localUpdated = l && l.updatedAt ? l.updatedAt : 0;

          if (s && l) {
            // If the server row has been soft-deleted, prefer the server-deleted state
            // unless the local row contains a newer local deletion (localDeleted > serverUpdated).
            const serverDeleted = s.deleted_at ? Date.parse(s.deleted_at) : null;
            const localDeleted = l && l.deletedAt ? l.deletedAt : null;

            if (serverDeleted && (!localDeleted || serverDeleted >= (localUpdated || 0))) {
              // Server deletion is authoritative: accept server row (will carry deletedAt)
              merged.push({ ...s, updatedAt: serverUpdated, deletedAt: serverDeleted });
            } else if (localDeleted && (!serverDeleted || localDeleted > serverUpdated)) {
              // Local deletion is newer -> push delete to server and keep local row
              toUpsert.push({
                key: l.key,
                // Without this, a match upserted here lands on the server with
                // a null event_key and drops out of every event-filtered query
                // from then on — including other devices syncing this event.
                // Derived from l.key first — see DataService.deriveEventKeyFromMatchKey.
                event_key: DataService.deriveEventKeyFromMatchKey(l.key) || l.event_key || eventKey || null,
                match_number: l.match_number,
                comp_level: l.comp_level,
                alliances: l.alliances,
                deleted_at: l.deletedAt ? new Date(l.deletedAt).toISOString() : null,
              });
              merged.push(l);
            } else if (localUpdated > serverUpdated) {
              // local wins -> upsert local
              toUpsert.push({
                key: l.key,
                // Derived from l.key first — see DataService.deriveEventKeyFromMatchKey.
                event_key: DataService.deriveEventKeyFromMatchKey(l.key) || l.event_key || eventKey || null,
                match_number: l.match_number,
                comp_level: l.comp_level,
                alliances: l.alliances,
                deleted_at: l.deletedAt ? new Date(l.deletedAt).toISOString() : null,
              });
              merged.push(l);
            } else {
              // server wins
              merged.push({ ...s, updatedAt: serverUpdated, deletedAt: s.deleted_at ? Date.parse(s.deleted_at) : null });
            }
          } else if (l && !s) {
            toUpsert.push({
              key: l.key,
              // Derived from l.key first — see DataService.deriveEventKeyFromMatchKey.
              event_key: DataService.deriveEventKeyFromMatchKey(l.key) || l.event_key || eventKey || null,
              match_number: l.match_number,
              comp_level: l.comp_level,
              alliances: l.alliances,
              deleted_at: l.deletedAt ? new Date(l.deletedAt).toISOString() : null,
            });
            merged.push(l);
          } else if (s && !l) {
            merged.push({ ...s, updatedAt: serverUpdated, deletedAt: s.deleted_at ? Date.parse(s.deleted_at) : null });
          }
        }

        if (toUpsert.length > 0) {
          try {
            const { error: upErr } = await client.from('matches').upsert(toUpsert, { onConflict: 'key' });
            if (upErr) console.error('SyncService: error upserting matches', upErr);
            else {
              const refreshQuery = eventKey
                ? client.from('matches').select('*').eq('event_key', eventKey)
                : client.from('matches').select('*');
              const { data: refreshed, error: refErr } = await refreshQuery;
              if (!refErr && refreshed) {
                const mapped = refreshed.map((m: any) => ({ ...m, updatedAt: m.updated_at ? Date.parse(m.updated_at) : Date.now(), deletedAt: m.deleted_at ? Date.parse(m.deleted_at) : null }));
                saveMerged(mapped as any);
                matchesUpserted = mapped.length;
              } else if (refErr) {
                console.error('SyncService: failed to refresh matches after upsert', refErr);
                saveMerged(merged as any);
                matchesUpserted = merged.length;
              }
            }
          } catch (e) {
            console.error('SyncService: exception upserting matches', e);
            saveMerged(merged as any);
            matchesUpserted = merged.length;
          }
        } else {
          saveMerged(merged as any);
          matchesUpserted = merged.length;
        }
      } catch (e) {
        console.error('SyncService: error merging matches', e);
        saveMerged(matches as any);
      }
    } else if (mErr) {
      console.error('SyncService: failed to pull matches', mErr);
    }
  } catch (e) {
    console.error('SyncService: error pulling matches', e);
  }
  // return a short status summary for UI consumption
  const summary = `Synced scouting: ${typeof pendingSynced === 'number' ? pendingSynced : 0}; server scouters: ${scoutersUpserted ?? 0}; matches synced: ${matchesUpserted ?? 0}`;
  // Notify listeners that the migration completed and server state may have changed
  try {
    notifyServerScoutingUpdated();
  } catch (e) {
    // ignore
  }
  try { console.timeEnd('sync:migrateLocalToServer'); } catch (e) {}
  return summary;
}

export async function migrateLocalToServer() {
  if (_inFlightSync) {
    // eslint-disable-next-line no-console
    console.debug('SyncService: migrateLocalToServer awaiting in-flight sync');
    return await _inFlightSync;
  }
  _inFlightSync = (async () => {
    try {
      return await _migrateLocalToServerBody();
    } finally {
      _inFlightSync = null;
    }
  })();
  return await _inFlightSync;
}

// Perform a full client refresh: clean local data, push pending rows, pull server state,
// then optionally activate waiting service worker or clear caches and reload the page.
export async function performFullRefresh(options?: { reload?: boolean }) {
  if (_inFlightFullRefresh) {
    // eslint-disable-next-line no-console
    console.debug('performFullRefresh awaiting in-flight full refresh');
    return await _inFlightFullRefresh;
  }
  _inFlightFullRefresh = (async () => {
    try {
      try { console.time('sync:performFullRefresh'); } catch (e) {}
      const doReload = options?.reload !== false;
      try {
        // 1) clean local data (non-destructive)
        try {
          // dynamic import DataService to avoid subtle circular issues
          // but DataService is already imported at top; call directly
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          const summary = await DataService.cleanAndNormalize();
          try {
            localStorage.setItem('frc-cleanup-summary', JSON.stringify({ removed: summary.removed, fixed: summary.fixed, pendingRemoved: summary.pendingRemoved }));
            localStorage.setItem('frc-cleanup-success', '1');
          } catch (e) {
            // ignore
          }
        } catch (e) {
          // cleaning failed; continue
          // eslint-disable-next-line no-console
          console.warn('performFullRefresh: cleanAndNormalize failed', e);
        }

        // 2) perform migration (push pending -> pull server)
        try {
          await migrateLocalToServer();
        } catch (e) {
          // bubble up or continue — we'll still attempt activation/clear
          // eslint-disable-next-line no-console
          console.warn('performFullRefresh: migrateLocalToServer failed', e);
        }

        // After migration, fetch authoritative matches from server and persist them
        // This enforces server-wins for matches so other clients receive deletions.
        // Scoped to the selected event — see the comment on the equivalent pull
        // in _migrateLocalToServerBody — and other events' local matches are
        // preserved rather than dropped by the full-array overwrite.
        try {
          const client = getSupabaseClient();
          if (client) {
            const eventKey = DataService.getSelectedEvent();
            const matchesQuery = eventKey
              ? client.from('matches').select('*').eq('event_key', eventKey)
              : client.from('matches').select('*');
            const { data: serverMatches, error: smErr } = await matchesQuery;
            if (!smErr && Array.isArray(serverMatches)) {
              const mapped = serverMatches.map((m: any) => ({ ...m, updatedAt: m.updated_at ? Date.parse(m.updated_at) : Date.now(), deletedAt: m.deleted_at ? Date.parse(m.deleted_at) : null }));
              const localOther = eventKey
                ? DataService.getMatches({ allEvents: true }).filter(
                    (m: any) => !DataService.matchBelongsToEvent(m, eventKey)
                  )
                : [];
              DataService.saveMatches([...localOther, ...mapped] as any);
            }
          }
        } catch (e) {
          // ignore fetch errors here; migration already attempted
          // eslint-disable-next-line no-console
          console.warn('performFullRefresh: failed to refresh authoritative matches', e);
        }

        // Also fetch authoritative scouting records from the server and replace local scouting data
        try {
          try {
            const serverRows = await fetchServerScouting();
            if (Array.isArray(serverRows)) {
              const mapped = serverRows.map((r: any) => ({
                id: r.id,
                matchKey: r.match_key,
                teamKey: r.team_key,
                scouter: r.scouter_name,
                alliance: r.alliance,
                position: r.position,
                auto: {
                  ...(r.payload?.auto || { l1: 0, l2: 0, l3: 0, l4: 0, hasAuto: false }),
                  net: typeof r.payload?.auto?.net === 'number' ? r.payload.auto.net : (r.payload?.auto?.net ? 1 : 0),
                },
                teleop: {
                  ...(r.payload?.teleop || { l1: 0, l2: 0, l3: 0, l4: 0 }),
                  net: typeof r.payload?.teleop?.net === 'number' ? r.payload.teleop.net : (r.payload?.teleop?.net ? 1 : 0),
                  prosser: typeof r.payload?.teleop?.prosser === 'number' ? r.payload.teleop.prosser : (r.payload?.teleop?.prosser ? 1 : 0),
                },
                endgame: r.payload?.endgame || { climb: 'none' },
                defense: r.payload?.defense || 'none',
                timestamp: r.timestamp ? Date.parse(r.timestamp) : Date.now(),
                updatedAt: r.updated_at ? Date.parse(r.updated_at) : Date.now(),
              }));
              // Replace local scouting data with authoritative server rows
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore
              DataService.replaceScoutingData(mapped as any[]);
            }
          } catch (e) {
            // ignore per-call errors
            // eslint-disable-next-line no-console
            console.warn('performFullRefresh: failed to fetch server scouting', e);
          }
        } catch (e) {
          // ignore overall
        }

        // broadcast update to any listeners (migrateLocalToServer also calls notify, but be explicit)
        try {
          notifyServerScoutingUpdated();
        } catch (e) {}

        if (!doReload) return 'refreshed';

        // 3) If there's a waiting service worker, request skipWaiting so it activates immediately
        try {
          if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.getRegistration();
            if (reg?.waiting) {
              try { reg.waiting?.postMessage({ type: 'SKIP_WAITING' }); } catch (e) {}
              // wait briefly for controllerchange then reload
              setTimeout(() => window.location.reload(), 500);
              return 'activated-waiting-worker';
            }
          }
        } catch (e) {
          // ignore
        }

        // 4) No waiting worker: unregister and clear caches then reload so fresh assets are fetched
        try {
          if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister().catch(() => {})));
          }
          if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
          }
        } catch (e) {
          // ignore
        }

        window.location.reload();
        return 'reloaded';
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('performFullRefresh failed', e);
        throw e;
      } finally {
        try { console.timeEnd('sync:performFullRefresh'); } catch (e) {}
      }
    } finally {
      _inFlightFullRefresh = null;
    }
  })();
  return await _inFlightFullRefresh;
}

// Perform a hard refresh: attempt to push pending, then clear all local site data
// (localStorage keys, caches, service workers) and reload. This mirrors a manual
// "clear site data" + reload that browsers perform.
export async function performHardRefresh() {
  try {
    // 1) Try to push pending data to server first, but don't block if it fails
    try {
      await migrateLocalToServer();
    } catch (e) {
      // ignore push failures
      // eslint-disable-next-line no-console
      console.warn('performHardRefresh: migrateLocalToServer failed', e);
    }

    // 2) Clear localStorage completely (mirrors manual clear-site-data)
    try {
      localStorage.clear();
    } catch (e) {
      // ignore
    }

    // 3) Unregister service workers and clear caches
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister().catch(() => {})));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch (e) {
      // ignore
    }

    // 4) Reload page so app boots clean and pulls fresh server data
    window.location.reload();
    return 'hard-reloaded';
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('performHardRefresh failed', e);
    throw e;
  }
}

// Notify other windows/tabs/components that server scouting may have changed.
let _notifyTimer: any = null;
function notifyServerScoutingUpdated() {
  try {
    if (typeof window === 'undefined' || !window || !window.dispatchEvent) return;
    // coalesce multiple rapid notifications into one dispatch
    if (_notifyTimer) return;
    _notifyTimer = window.setTimeout(() => {
      try {
        // eslint-disable-next-line no-undef
        window.dispatchEvent(new CustomEvent('server-scouting-updated'));
      } catch (e) {
        // ignore
      } finally {
        _notifyTimer = null;
      }
    }, 250);
  } catch (e) {
    // ignore environments without CustomEvent or window
    // eslint-disable-next-line no-console
    console.debug('notifyServerScoutingUpdated failed', e);
  }
}

// push scouters (array) to server immediately and refresh local storage
export async function pushScoutersToServer(scouters: any[]) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase client not configured; cannot push scouters.');
  }

  try {
    // ensure ids are UUID-like; generate UUIDs for any non-uuid ids
    const prepared = await Promise.all(scouters.map(async (s: any) => {
      let id = s.id;
      const isUuidLike = typeof id === 'string' && id.length === 36 && id.includes('-');
      if (!isUuidLike) {
        id = uuidv4();
      }
      return {
        id,
        name: s.name,
        alliance: s.alliance,
        position: s.position,
        is_remote: s.isRemote ?? false,
        deleted_at: s.deletedAt ? new Date(s.deletedAt).toISOString() : null,
      };
    }));

    const { error } = await client.from('scouters').upsert(prepared, { onConflict: 'id' });
    if (error) {
      // If the error mentions a missing deleted_at column, retry by removing deleted_at
      // but also perform hard deletes for rows that were explicitly deleted locally so the delete persists.
      const message = (error.message || JSON.stringify(error)).toString();
      if (message.toLowerCase().includes('deleted_at') || (error.details && String(error.details).toLowerCase().includes('deleted_at'))) {
        // split prepared into deleted and non-deleted
        const deletedIds: string[] = prepared.filter((p: any) => p.deleted_at).map((p: any) => p.id);
        const preparedNoDeleted = prepared.map((p: any) => {
          const copy: any = { ...p };
          delete copy.deleted_at;
          return copy;
        });

        // First upsert the non-deleted rows (without deleted_at)
        const { error: retryErr } = await client.from('scouters').upsert(preparedNoDeleted, { onConflict: 'id' });
        if (retryErr) {
          throw new Error('pushScoutersToServer: upsert error after retry without deleted_at: ' + (retryErr.message || JSON.stringify(retryErr)));
        }

        // Then, for any rows that were marked deleted locally, attempt hard delete so they are removed from DB
        if (deletedIds.length > 0) {
          try {
            const { error: delErr } = await client.from('scouters').delete().in('id', deletedIds);
            if (delErr) {
              // If delete failed, surface an error so caller knows
              throw new Error('pushScoutersToServer: delete error for removed scouters: ' + (delErr.message || JSON.stringify(delErr)));
            }
          } catch (delEx) {
            // If delete throws, rethrow as a descriptive error
            throw delEx;
          }
        }
      } else {
        throw new Error('pushScoutersToServer: upsert error: ' + message);
      }
    }

    // refresh authoritative rows
    const { data: refreshed, error: refErr } = await client.from('scouters').select('*');
    if (refErr) {
      throw new Error('pushScoutersToServer: failed to refresh scouters: ' + (refErr.message || JSON.stringify(refErr)));
    }

    if (refreshed) {
      const mapped = refreshed.map((s: any) => ({
        id: s.id,
        name: s.name,
        alliance: s.alliance,
        position: s.position,
        isRemote: s.is_remote ?? s.isRemote ?? false,
        updatedAt: s.updated_at ? Date.parse(s.updated_at) : Date.now(),
        deletedAt: s.deleted_at ? Date.parse(s.deleted_at) : null,
      }));
      DataService.saveScouters(mapped as any);
      return `Upserted ${mapped.length} scouters`;
    }
  } catch (e) {
    throw e;
  }
}

export async function fetchServerScouters() {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase client not configured; cannot fetch scouters.');
  const { data, error } = await client.from('scouters').select('*').order('updated_at', { ascending: false }).limit(500);
  if (error) throw error;
  return data || [];
}

// fetch all scouting records from server
export async function fetchServerScouting() {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase client not configured; cannot fetch scouting records.');
  if (_fetchScoutingLock) {
    // eslint-disable-next-line no-console
    console.debug('SyncService: fetchServerScouting skipped because another fetch is running');
    return [];
  }
  _fetchScoutingLock = true;
  try {
    // TEMP LOG: time server scouting fetch
    try { console.time('sync:fetchServerScouting'); } catch (e) {}
    const { data, error } = await client.from('scouting_records').select('*').order('timestamp', { ascending: false }).limit(1000);
    if (error) throw error;
    try { console.timeEnd('sync:fetchServerScouting'); } catch (e) {}
    return data || [];
  } finally {
    _fetchScoutingLock = false;
  }
}

// fetch pit scouting data from server. If teamKey provided, return single team's pit data, otherwise return map of team_key->data
export async function fetchPitData(teamKey?: string) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase client not configured; cannot fetch pit data.');
  try {
    if (teamKey) {
      const { data, error } = await client.from('pit_data').select('*').eq('team_key', teamKey).limit(1).single();
      if (error) {
        // if not found, return null
        if ((error as any).code === 'PGRST116' || (error as any).status === 404) return null;
        throw error;
      }
      return data || null;
    }
    const { data, error } = await client.from('pit_data').select('*').limit(1000);
    if (error) throw error;
    // return array
    return data || [];
  } catch (err) {
    throw err;
  }
}

// upsert pit scouting for a team to server
export async function upsertPitData(teamKey: string, data: any) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase client not configured; cannot upsert pit data.');
  try {
    const row = {
      team_key: teamKey,
      payload: data,
      updated_at: new Date().toISOString(),
    };
    const { error } = await client.from('pit_data').upsert(row, { onConflict: 'team_key' });
    if (error) throw error;
    return true;
  } catch (err) {
    throw err;
  }
}

// upload a single pit image (data URL) to Supabase Storage and return a public URL
export async function uploadPitImage(teamKey: string, dataUrl: string) {
  const client = getSupabaseClient();
  if (!client) {
    // eslint-disable-next-line no-console
    console.error('uploadPitImage: no supabase client available');
    throw new Error('Supabase client not configured; cannot upload pit image.');
  }
  try {
    // eslint-disable-next-line no-console
    console.debug('uploadPitImage: starting upload for', teamKey);
    // convert dataURL to blob
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const ext = (blob.type && blob.type.split('/')[1]) || 'jpg';
    const filename = `${teamKey}/${Date.now()}-${uuidv4()}.${ext}`;
    // upload to bucket 'pit-images' (bucket must exist)
    // include contentType so Supabase stores correct metadata
    const { data: uploadData, error: uploadErr } = await client.storage.from('pit-images').upload(filename, blob, { upsert: false, contentType: blob.type });
    if (uploadErr) {
      // eslint-disable-next-line no-console
      console.error('uploadPitImage: upload error', uploadErr);
      throw uploadErr;
    }
    // eslint-disable-next-line no-console
    console.debug('uploadPitImage: upload response', uploadData);
    // get public URL (Supabase returns { data: { publicUrl } })
    const publicRes: any = client.storage.from('pit-images').getPublicUrl(filename);
    const publicUrl = publicRes && publicRes.data ? (publicRes.data.publicUrl || publicRes.data.publicURL) : (publicRes?.publicUrl || publicRes?.publicURL);
    if (!publicUrl) {
      // eslint-disable-next-line no-console
      console.warn('uploadPitImage: could not obtain public URL for', filename, publicRes);
      return null;
    }
    // eslint-disable-next-line no-console
    console.debug('uploadPitImage: completed upload ->', publicUrl);
    return publicUrl;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('uploadPitImage: exception', err);
    throw err;
  }
}

// list all pit images for a team from the storage bucket and return public URLs
export async function listPitImages(teamKey: string) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase client not configured; cannot list pit images.');
  try {
    const teamNum = (teamKey || '').replace(/^frc/i, '');
    const teamFolder = `frc${teamNum}`;
    const teamFolderLower = teamFolder.toLowerCase();

    // First: page through the canonical folder `frc<teamNum>` and return everything there.
    const primaryPrefix = teamFolder;
    try {
      const limit = 1000;
      let offset = 0;
      const filesInFolder: string[] = [];
      while (true) {
        const listRes: any = await client.storage.from('pit-images').list(primaryPrefix, { limit, offset });
        if (listRes?.error) {
          // eslint-disable-next-line no-console
          console.warn('listPitImages: storage list for prefix error', primaryPrefix, listRes.error);
          break;
        }
        const entries = Array.isArray(listRes?.data) ? listRes.data : [];
        if (entries.length === 0) break;
        for (const f of entries) {
          const name = f.name || f.path || f.id || f;
          if (!name) continue;
          const nameStr = String(name);
          // if name is returned relative to prefix, build full path
          const fullName = nameStr.toLowerCase().startsWith(primaryPrefix.toLowerCase()) ? nameStr : `${primaryPrefix}/${nameStr}`;
          filesInFolder.push(fullName);
        }
        if (entries.length < limit) break;
        offset += entries.length;
      }

      if (filesInFolder.length > 0) {
        const urls: string[] = [];
        for (const fullName of filesInFolder) {
          try {
            const resolved = await resolvePublicUrl(client, 'pit-images', fullName);
            if (resolved) urls.push(resolved);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('listPitImages: failed to resolve public URL for', fullName, e);
          }
        }
        try { console.debug('listPitImages: primary folder', primaryPrefix, 'found files=', filesInFolder.length, 'urls=', urls.length); } catch (e) {}
        return urls;
      }
      // If nothing found, try listing with a trailing slash (some SDK/backends treat folder vs prefix differently)
      try {
        const altPrefix = `${primaryPrefix}/`;
        let offset2 = 0;
        const filesInFolder2: string[] = [];
        while (true) {
          const listRes2: any = await client.storage.from('pit-images').list(altPrefix, { limit, offset: offset2 });
          if (listRes2?.error) {
            console.warn('listPitImages: storage list for alt prefix error', altPrefix, listRes2.error);
            break;
          }
          const entries2 = Array.isArray(listRes2?.data) ? listRes2.data : [];
          if (entries2.length === 0) break;
          for (const f of entries2) {
            const name = f.name || f.path || f.id || f;
            if (!name) continue;
            const nameStr = String(name);
            const fullName = nameStr.toLowerCase().startsWith(primaryPrefix.toLowerCase()) ? nameStr : `${primaryPrefix}/${nameStr}`;
            filesInFolder2.push(fullName);
          }
          if (entries2.length < limit) break;
          offset2 += entries2.length;
        }

        if (filesInFolder2.length > 0) {
          const urls2: string[] = [];
          for (const fullName of filesInFolder2) {
            try {
              const resolved = await resolvePublicUrl(client, 'pit-images', fullName);
              if (resolved) urls2.push(resolved);
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn('listPitImages: failed to resolve public URL for', fullName, e);
            }
          }
          try { console.debug('listPitImages: primary folder (alt)', altPrefix, 'found files=', filesInFolder2.length, 'urls=', urls2.length); } catch (e) {}
          return urls2;
        }
      } catch (e) {
        // ignore
      }
    } catch (e) {
      // ignore and fall back to scanning whole bucket
      console.warn('listPitImages: primary prefix scan failed', e);
    }

    // As a fallback, page through the entire bucket and return any files
    // whose name contains the team key or team number. Use pagination so
    // large buckets don't truncate results and use `includes` to catch
    // nested/legacy paths (not just prefixes). Collect all matches (do not dedupe)
    // so duplicate uploads are preserved.
    try {
      const limit = 1000;
      let offset = 0;
      const matchedNames: string[] = [];
      // First, list top-level entries and probe any folder that may match the team folder
      try {
        const rootRes: any = await client.storage.from('pit-images').list('', { limit, offset });
        if (rootRes?.error) {
          console.warn('listPitImages: root list error', rootRes.error);
        } else {
          const rootEntries = Array.isArray(rootRes?.data) ? rootRes.data : [];
          for (const re of rootEntries) {
            const rname = String(re.name || re.path || re.id || re || '');
            const rLower = rname.toLowerCase();
            if (rLower.includes(teamFolderLower) || rLower.includes(teamNum)) {
              // attempt to list inside this folder
              try {
                const innerRes: any = await client.storage.from('pit-images').list(rname, { limit: 1000 });
                if (!innerRes?.error && Array.isArray(innerRes.data) && innerRes.data.length > 0) {
                  for (const f of innerRes.data) {
                    const name = f.name || f.path || f.id || f;
                    if (!name) continue;
                    const nameStr = String(name);
                    const fullName = nameStr.toLowerCase().startsWith(rname.toLowerCase()) ? nameStr : `${rname}/${nameStr}`;
                    matchedNames.push(fullName);
                  }
                }
              } catch (e) {
                // ignore per-folder errors
              }
            }
          }
        }
      } catch (e) {
        // fall back to naive full listing if root list fails
        while (true) {
          const listRes: any = await client.storage.from('pit-images').list('', { limit, offset });
          if (listRes?.error) {
            // eslint-disable-next-line no-console
            console.warn('listPitImages: storage list page error', listRes.error);
            break;
          }
          const files = Array.isArray(listRes?.data) ? listRes.data : [];
          if (files.length === 0) break;
          for (const f of files) {
            const name = f.name || f.path || f.id || f;
            if (!name) continue;
            const nameStr = String(name);
            const nameLower = nameStr.toLowerCase();
            // match if the canonical folder token appears in the filename
            if (nameLower.includes(teamFolderLower) || nameLower.includes(teamNum)) {
              matchedNames.push(nameStr);
            }
          }
          if (files.length < limit) break;
          offset += files.length;
        }
      }

      // debug: log how many raw matches we found
      try { console.debug('listPitImages: matched filenames count=', matchedNames.length); } catch (e) {}
      const urls: string[] = [];
      for (const name of matchedNames) {
        try {
          const resolved = await resolvePublicUrl(client, 'pit-images', name);
          if (resolved) urls.push(resolved);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('listPitImages: failed to resolve public URL for', name, e);
        }
      }
      try { console.debug('listPitImages: returning public urls count=', urls.length); } catch (e) {}
      // If browser listing finds nothing but a server-side listing endpoint is configured,
      // try that as a fallback. This is useful when the anon client cannot list the bucket
      // but a server endpoint using the service role key can.
      if ((!urls || urls.length === 0)) {
        try {
          const endpoint = (import.meta as any).env?.VITE_PIT_LIST_ENDPOINT || '/.netlify/functions/list-pit-images';
          if (endpoint) {
            try {
              // expect JSON: { files: string[] } or { urls: string[] }
              const resp = await fetch(`${endpoint}?team=${encodeURIComponent(teamFolder)}`);
              if (resp && resp.ok) {
                const body = await resp.json();
                const serverFiles: string[] = Array.isArray(body?.files) ? body.files : (Array.isArray(body?.urls) ? body.urls : []);
                const serverUrls: string[] = [];
                for (const sf of serverFiles) {
                  // If server returned full URLs, accept them; otherwise resolve path
                  if (typeof sf === 'string' && (sf.startsWith('http://') || sf.startsWith('https://'))) {
                    serverUrls.push(sf);
                  } else if (typeof sf === 'string') {
                    const path = sf.startsWith(teamFolder) ? sf : `${teamFolder}/${sf}`;
                    const r = await resolvePublicUrl(client, 'pit-images', path);
                    if (r) serverUrls.push(r);
                  }
                }
                if (serverUrls.length > 0) {
                  try { console.debug('listPitImages: server endpoint returned urls count=', serverUrls.length); } catch (e) {}
                  return serverUrls;
                }
              }
            } catch (e) {
              console.warn('listPitImages: server endpoint fallback failed', e);
            }
          }
        } catch (e) {
          // ignore endpoint fallback errors
        }
      }
      return urls;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('listPitImages: exception listing all files', e);
      return [];
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('listPitImages: exception', err);
    return [];
  }
}

// return matched file names (raw) for diagnostics — includes duplicates and nested matches
export async function listPitFiles(teamKey: string) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase client not configured; cannot list pit files.');
  try {
    const teamNum = (teamKey || '').replace(/^frc/i, '');
    const teamKeyLower = (teamKey || '').toLowerCase();
    const teamNumLower = (teamNum || '').toLowerCase();
    const candidates = [] as string[];
    if (teamKey) candidates.push(teamKey);
    if (teamNum && teamNum !== teamKey) candidates.push(teamNum);
    const altTokens = new Set<string>([teamKeyLower, teamNumLower, (`frc${teamNumLower}`).toLowerCase()]);

    const matchedNames: string[] = [];

    // try prefixes
    for (const prefix of candidates) {
      try {
        const listRes: any = await client.storage.from('pit-images').list(prefix, { limit: 1000 });
        if (!listRes?.error && Array.isArray(listRes.data) && listRes.data.length > 0) {
          for (const f of listRes.data) {
            const name = f.name || f.path || f.id || f;
            if (!name) continue;
            const nameLower = String(name).toLowerCase();
            for (const t of altTokens) {
              if (t && nameLower.includes(t)) { matchedNames.push(name); break; }
            }
          }
        }
        // also try with trailing slash
        if ((!matchedNames || matchedNames.length === 0) && prefix) {
          const alt = `${prefix}/`;
          try {
            const listRes2: any = await client.storage.from('pit-images').list(alt, { limit: 1000 });
            if (!listRes2?.error && Array.isArray(listRes2.data) && listRes2.data.length > 0) {
              for (const f of listRes2.data) {
                const name = f.name || f.path || f.id || f;
                if (!name) continue;
                const nameLower = String(name).toLowerCase();
                for (const t of altTokens) {
                  if (t && nameLower.includes(t)) { matchedNames.push(name); break; }
                }
              }
            }
          } catch (e) {}
        }
      } catch (e) {
        // ignore
      }
    }

    // Inspect root entries and probe matching folders; fall back to paging root if needed
    try {
      const limit = 1000;
      let offset = 0;
      const rootRes: any = await client.storage.from('pit-images').list('', { limit, offset });
      if (!rootRes?.error) {
        const rootEntries = Array.isArray(rootRes?.data) ? rootRes.data : [];
        for (const re of rootEntries) {
          const rname = String(re.name || re.path || re.id || '');
          const rLower = rname.toLowerCase();
          for (const t of altTokens) {
            if (t && rLower.includes(t)) {
              try {
                const innerRes: any = await client.storage.from('pit-images').list(rname, { limit: 1000 });
                if (!innerRes?.error && Array.isArray(innerRes.data) && innerRes.data.length > 0) {
                  for (const f of innerRes.data) {
                    const name = f.name || f.path || f.id || f;
                    if (!name) continue;
                    matchedNames.push(name);
                  }
                }
              } catch (e) {}
              break;
            }
          }
        }
      } else {
        // If root list failed, fall back to paged root listing
        while (true) {
          const listRes: any = await client.storage.from('pit-images').list('', { limit, offset });
          if (listRes?.error) break;
          const files = Array.isArray(listRes?.data) ? listRes.data : [];
          if (files.length === 0) break;
          for (const f of files) {
            const name = f.name || f.path || f.id || f;
            if (!name) continue;
            const nameLower = String(name).toLowerCase();
            for (const t of altTokens) {
              if (t && nameLower.includes(t)) { matchedNames.push(name); break; }
            }
          }
          if (files.length < limit) break;
          offset += files.length;
        }
      }
    } catch (e) {
      // ignore
    }

    return matchedNames;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('listPitFiles: exception', err);
    return [];
  }
}

// Return detailed diagnostics about which prefixes/entries were inspected
export async function getPitListingDiagnostics(teamKey: string) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase client not configured; cannot list pit diagnostics.');
  const diag: any = { triedPrefixes: [], rootEntries: [], matchedNamesSample: [], errors: [] };
  try {
    try {
      diag.client = getSupabaseInfo ? getSupabaseInfo() : null;
    } catch (e) {
      diag.client = null;
    }
    const teamNum = (teamKey || '').replace(/^frc/i, '');
    const teamFolder = `frc${teamNum}`;
    const altPrefix = `${teamFolder}/`;

    // try primary prefix
    try {
      const res: any = await client.storage.from('pit-images').list(teamFolder, { limit: 1000 });
      diag.triedPrefixes.push({ prefix: teamFolder, raw: res && typeof res === 'object' ? JSON.stringify(res, null, 2).slice(0, 1000) : String(res) });
      if (!res?.error) {
        const names = Array.isArray(res.data) ? res.data.map((d: any) => (d.name || d.path || d.id || d)) : [];
        diag.triedPrefixes[diag.triedPrefixes.length - 1].count = names.length;
        diag.triedPrefixes[diag.triedPrefixes.length - 1].sample = names.slice(0, 10);
      } else {
        diag.triedPrefixes[diag.triedPrefixes.length - 1].error = String(res.error);
      }
    } catch (e: any) {
      diag.triedPrefixes.push({ prefix: teamFolder, error: String(e) });
    }

    // try alt prefix with trailing slash
    try {
      const res2: any = await client.storage.from('pit-images').list(altPrefix, { limit: 1000 });
      diag.triedPrefixes.push({ prefix: altPrefix, raw: res2 && typeof res2 === 'object' ? JSON.stringify(res2, null, 2).slice(0, 1000) : String(res2) });
      if (!res2?.error) {
        const names2 = Array.isArray(res2.data) ? res2.data.map((d: any) => (d.name || d.path || d.id || d)) : [];
        diag.triedPrefixes[diag.triedPrefixes.length - 1].count = names2.length;
        diag.triedPrefixes[diag.triedPrefixes.length - 1].sample = names2.slice(0, 10);
      } else {
        diag.triedPrefixes[diag.triedPrefixes.length - 1].error = String(res2.error);
      }
    } catch (e: any) {
      diag.triedPrefixes.push({ prefix: altPrefix, error: String(e) });
    }

    // list root entries (top-level folders/files)
    try {
      const root: any = await client.storage.from('pit-images').list('', { limit: 1000 });
      diag.rootRaw = root && typeof root === 'object' ? JSON.stringify(root, null, 2).slice(0, 4000) : String(root);
      if (!root?.error) {
        const rootNames = Array.isArray(root.data) ? root.data.map((d: any) => (d.name || d.path || d.id || d)) : [];
        diag.rootEntries = { count: rootNames.length, sample: rootNames.slice(0, 20) };
      } else {
        diag.rootEntries = { error: String(root.error) };
      }
    } catch (e: any) {
      diag.rootEntries = { error: String(e) };
    }

    // collect a small sample of matched names using listPitFiles logic
    try {
      const matched = await listPitFiles(teamKey);
      diag.matchedNamesCount = matched.length;
      diag.matchedNamesSample = matched.slice(0, 20);
    } catch (e: any) {
      diag.errors.push(String(e));
    }

    return diag;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('getPitListingDiagnostics: exception', err);
    diag.errors.push(String(err));
    return diag;
  }
}

// delete all scouting records from server
export async function deleteScoutingFromServer() {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase client not configured; cannot delete scouting records.');
  try {
    // fetch all ids first to avoid comparing uuid to empty string (which causes parse errors)
    const { data: idsData, error: fetchErr } = await client.from('scouting_records').select('id').limit(1000);
    if (fetchErr) throw fetchErr;
    const ids: string[] = Array.isArray(idsData) ? idsData.map((r: any) => r.id).filter(Boolean) : [];
    if (ids.length === 0) return true;

    // delete by id list
    const { error: delErr } = await client.from('scouting_records').delete().in('id', ids);
    if (delErr) throw delErr;
    return true;
  } catch (err) {
    const e: any = err;
    throw new Error('deleteScoutingFromServer: ' + (e?.message || String(e)));
  }
}

// delete all pit_data rows and remove storage files in the 'pit-images' bucket
export async function deletePitDataFromServer() {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase client not configured; cannot delete pit data.');
  try {
    // fetch pit_data rows (we must delete with a WHERE clause; Supabase rejects blind deletes)
    const { data: pitRows, error: fetchErr } = await client.from('pit_data').select('team_key').limit(1000);
    if (fetchErr) throw fetchErr;
    const keys: string[] = Array.isArray(pitRows) ? pitRows.map((r: any) => r.team_key).filter(Boolean) : [];
    if (keys.length > 0) {
      const { error: delErr } = await client.from('pit_data').delete().in('team_key', keys);
      if (delErr) throw delErr;
    }

    // attempt to list and remove files from the storage bucket 'pit-images'
    try {
      const listRes: any = await client.storage.from('pit-images').list('');
      if (listRes?.error) {
        // not fatal - surface later if needed
        console.warn('deletePitDataFromServer: storage list error', listRes.error);
      } else if (Array.isArray(listRes?.data) && listRes.data.length > 0) {
        const files = listRes.data.map((f: any) => f.name).filter(Boolean);
        if (files.length > 0) {
          const { error: remErr } = await client.storage.from('pit-images').remove(files);
          if (remErr) {
            // surface as non-fatal
            console.warn('deletePitDataFromServer: failed to remove some files', remErr);
          }
        }
      }
    } catch (e) {
      console.warn('deletePitDataFromServer: storage cleanup failed', e);
    }

    return true;
  } catch (err) {
    const e: any = err;
    throw new Error('deletePitDataFromServer: ' + (e?.message || String(e)));
  }
}

// push matches array to server immediately and refresh local storage
export async function pushMatchesToServer(matches: any[]) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase client not configured; cannot push matches.');

  try {
    const prepared = matches.map((m: any) => ({
      // Derive from the match's own key, not from m.event_key or "whichever
      // event is selected right now" — both are state that can go stale and
      // silently relabel a whole event's schedule as another's on push. See
      // DataService.deriveEventKeyFromMatchKey.
      event_key:
        DataService.deriveEventKeyFromMatchKey(m.key) ||
        m.event_key ||
        (DataService && DataService.getSelectedEvent && DataService.getSelectedEvent()) ||
        null,
      key: m.key,
      match_number: m.match_number,
      comp_level: m.comp_level,
      alliances: m.alliances,
      deleted_at: m.deletedAt ? new Date(m.deletedAt).toISOString() : null,
    }));

    // If matches reference an event_key that doesn't exist in the events table,
    // PostgreSQL will reject the insert due to the foreign key constraint. Ensure
    // minimal event rows exist first (just the key) so matches can be upserted.
    const eventKeys = Array.from(new Set(prepared.map((p: any) => p.event_key).filter(Boolean)));
    if (eventKeys.length > 0) {
      try {
        const eventsToUpsert = eventKeys.map(k => ({ key: k }));
        const { error: evErr } = await client.from('events').upsert(eventsToUpsert, { onConflict: 'key' });
        if (evErr) {
          // If upserting events fails, surface a clear error so caller can act.
          throw new Error('pushMatchesToServer: failed to ensure events exist: ' + (evErr.message || JSON.stringify(evErr)));
        }
      } catch (e) {
        // bubble up the error to the caller; it's better to fail loudly than corrupt expectations
        throw e;
      }
    }

    const { error } = await client.from('matches').upsert(prepared, { onConflict: 'key' });
    if (error) {
      const message = (error.message || JSON.stringify(error)).toString();
      if (message.toLowerCase().includes('deleted_at') || (error.details && String(error.details).toLowerCase().includes('deleted_at'))) {
        // retry without deleted_at and proceed
        const preparedNoDeleted = prepared.map((p: any) => {
          const copy: any = { ...p };
          delete copy.deleted_at;
          return copy;
        });
        const { error: retryErr } = await client.from('matches').upsert(preparedNoDeleted, { onConflict: 'key' });
        if (retryErr) throw retryErr;
      } else {
        throw error;
      }
    }

    // Refresh authoritative rows for the event(s) just pushed — normally just
    // one. Pulling every event on the server (as this used to) is what made
    // saving a newly-loaded event's matches bring back the previous event's
    // teams: the very next line replaces local storage wholesale.
    const refreshQuery =
      eventKeys.length === 1
        ? client.from('matches').select('*').eq('event_key', eventKeys[0])
        : eventKeys.length > 1
          ? client.from('matches').select('*').in('event_key', eventKeys)
          : client.from('matches').select('*');
    const { data: refreshed, error: refErr } = await refreshQuery;
    if (refErr) throw refErr;
    if (refreshed) {
      const localOther = eventKeys.length
        ? DataService.getMatches({ allEvents: true }).filter(
            (m: any) => !eventKeys.some((ek) => DataService.matchBelongsToEvent(m, ek))
          )
        : [];
      const mapped = [
        ...localOther,
        ...refreshed.map((m: any) => ({ ...m, updatedAt: m.updated_at ? Date.parse(m.updated_at) : Date.now(), deletedAt: m.deleted_at ? Date.parse(m.deleted_at) : null })),
      ];
      DataService.saveMatches(mapped as any);
      return mapped.length;
    }
    return 0;
  } catch (e) {
    throw e;
  }
}

// delete matches by key from server
export async function deleteMatchesFromServer(keys: string[]) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase client not configured; cannot delete matches.');

  try {
    // Prefer soft-delete: set deleted_at so clients can reconcile deletions deterministically
    const now = new Date().toISOString();
    const { error } = await client.from('matches').update({ deleted_at: now }).in('key', keys);
    if (error) {
      // If the DB doesn't support updates to deleted_at, fallback to hard delete
      try {
        const { error: delErr } = await client.from('matches').delete().in('key', keys);
        if (delErr) throw delErr;
        return true;
      } catch (e) {
        throw new Error('deleteMatchesFromServer: ' + (error.message || JSON.stringify(error)));
      }
    }
    return true;
  } catch (e) {
    throw e;
  }
}

// fetch matches currently stored on Supabase (optionally limit) and include event_key
/**
 * Matches on the server for one event, defaulting to whichever event is
 * currently selected. Pass `eventKey` explicitly for callers that track
 * their own event-selection state rather than relying on
 * `DataService.getSelectedEvent()`, which can lag one render behind a fresh
 * pick — e.g. the "Queued matches on server" panel.
 */
export async function fetchServerMatches(limit = 500, eventKey?: string | null) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase client not configured; cannot fetch matches.');

  const key = eventKey !== undefined ? eventKey : DataService.getSelectedEvent();
  let query = client.from('matches').select('*').order('updated_at', { ascending: false }).limit(limit);
  if (key) query = query.eq('event_key', key);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

let initialized = false;
let _storageDebounceTimer: any = null;

export function initializeSyncService() {
  if (initialized) return;
  initialized = true;

  // attempt sync now if online. If a service worker is controlling the page, delay startup sync briefly
  if (DataService.isOnline()) {
    const startupDelay = (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && navigator.serviceWorker.controller) ? 500 : 0;
    setTimeout(() => {
      if (DataService.isOnline()) migrateLocalToServer().then(() => console.log('SyncService: migration complete'));
    }, startupDelay);
  }

  // when the app comes back online, try to sync
  window.addEventListener('online', () => {
    migrateLocalToServer().catch(() => {});
  });

  // cross-tab updates: if other tab modified pending queue, react (debounced)
  window.addEventListener('storage', (e) => {
    if (e.key === 'frc-pending-scouting') {
      if (!DataService.isOnline()) return;
      if (_storageDebounceTimer) clearTimeout(_storageDebounceTimer);
      _storageDebounceTimer = window.setTimeout(() => {
        migrateLocalToServer().catch(() => {});
        _storageDebounceTimer = null;
      }, 250);
    }
  });

  // periodic background sync: attempt every 60s if online
  setInterval(() => {
    if (DataService.isOnline()) migrateLocalToServer().catch(() => {});
  }, 60_000);
}

export default {
  initializeSyncService,
  pushPendingToServer,
};

// Expose debug helpers for manual testing in browser consoles
try {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (typeof window !== 'undefined') {
    // @ts-ignore
    window.syncNow = async () => {
      // eslint-disable-next-line no-console
      console.log('syncNow: triggering migrateLocalToServer()');
      try {
        const res = await migrateLocalToServer();
        // eslint-disable-next-line no-console
        console.log('syncNow: migration finished, result:', res);
        return res;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('syncNow: migration error', e);
        throw e;
      }
    };

    // @ts-ignore
    window.pushPendingToServerNow = async () => {
      // eslint-disable-next-line no-console
      console.log('pushPendingToServerNow: triggering pushPendingToServer()');
      try {
        const res = await pushPendingToServer({ batchSize: 100, maxRetries: 3 });
        // eslint-disable-next-line no-console
        console.log('pushPendingToServerNow: finished, totalSynced=', res);
        return res;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('pushPendingToServerNow: error', e);
        throw e;
      }
    };
    try {
      // expose supabase client info helper for debugging
      // @ts-ignore
      window.getSupabaseInfo = () => {
        try { return getSupabaseInfo ? getSupabaseInfo() : null; } catch (e) { return null; }
      };
    } catch (e) {}
    try {
      // expose raw storage debug helpers
      // @ts-ignore
      window.debugListBucket = async (bucket: string, prefix = '') => {
        try {
          const client = getSupabaseClient();
          if (!client) return { error: 'no-client' };
          const res = await client.storage.from(bucket).list(prefix, { limit: 1000 });
          return res;
        } catch (e) { return { error: String(e) }; }
      };
      // @ts-ignore
      window.debugGetPublicUrl = (bucket: string, path: string) => {
        try {
          const client = getSupabaseClient();
          if (!client) return null;
          const res: any = client.storage.from(bucket).getPublicUrl(path);
          return res;
        } catch (e) { return { error: String(e) }; }
      };
      // @ts-ignore
      window.debugCreateSignedUrl = async (bucket: string, path: string, expires = 60) => {
        try {
          const client = getSupabaseClient();
          if (!client) return { error: 'no-client' };
          const res = await client.storage.from(bucket).createSignedUrl(path, expires);
          return res;
        } catch (e) { return { error: String(e) }; }
      };
    } catch (e) {}
  }
} catch (e) {
  // ignore if window isn't available
}
