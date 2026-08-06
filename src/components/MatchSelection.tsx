import { useState, useEffect } from 'react';
import { Event, Match } from '../types';
import { fetchEvents, fetchEventMatches, getRuntimeTbaKey, setRuntimeTbaKey, clearRuntimeTbaKey } from '../services/tbaApi';
import { DataService } from '../services/dataService';
import { migrateLocalToServer, pushMatchesToServer, deleteMatchesFromServer, fetchServerMatches, performFullRefresh } from '../services/syncService';
import { readableMatchLabel, compareMatches } from '../utils/match';

interface MatchSelectionProps {
  onBack: () => void;
}

/** Shared column track for the match table (mockup: 70px 1fr 1fr 64px). */
const MATCH_COLS = '70px 1fr 1fr 64px';

const teamList = (keys: string[]) => keys.map(t => t.replace('frc', '')).join(' · ');

export function MatchSelection({ onBack }: MatchSelectionProps) {
  const [events, setEvents] = useState<Event[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<string>('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [runtimeKey, setRuntimeKey] = useState<string>('');
  const [serverMatches, setServerMatches] = useState<any[]>([]);
  const [serverLoading, setServerLoading] = useState(false);

  useEffect(() => {
    // Do not auto-load events on mount. User must click 'Check available events' to fetch from TBA.
    try {
      const k = getRuntimeTbaKey();
      if (k) setRuntimeKey(k);
    } catch (e) {}
  }, []);

  // On mount, hydrate matches from local storage (so admin sees saved/queued matches)
  useEffect(() => {
    try {
      const sel = DataService.getSelectedEvent();
      if (sel) setSelectedEvent(sel);
      const stored = (DataService.getMatches() || []).filter((m: any) => !m.deletedAt);
      if (stored && stored.length > 0) {
        const sorted = stored.slice().sort(compareMatches);
        setMatches(sorted as Match[]);
      }
    } catch (e) {
      // ignore
    }

    const onStorage = (e: StorageEvent) => {
          if (e.key === 'frc-matches' || e.key === 'frc-selected-event') {
        try {
          const sel = DataService.getSelectedEvent();
          if (sel) setSelectedEvent(sel);
          const stored = (DataService.getMatches() || []).filter((m: any) => !m.deletedAt);
          setMatches((stored as any[]).slice().sort(compareMatches));
        } catch (err) {
          // ignore
        }
      }
    };
    const onServer = () => {
        try {
          const sel = DataService.getSelectedEvent();
          if (sel) setSelectedEvent(sel);
          const stored = (DataService.getMatches() || []).filter((m: any) => !m.deletedAt);
          setMatches((stored as any[]).slice().sort(compareMatches));
        } catch (err) {}
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('server-scouting-updated', onServer as EventListener);
    return () => window.removeEventListener('storage', onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMatches = async (eventKey: string) => {
    setLoading(true);
    try {
      // Try to fetch real matches from TBA; fall back to any locally stored matches or an empty list
      const fetched = await fetchEventMatches(eventKey);
      // TBA returns an array of match objects; if empty, it may indicate matches not yet released
      if (Array.isArray(fetched) && fetched.length > 0) {
        const sorted = (fetched as Match[]).slice().sort(compareMatches);
        setMatches(sorted);
        DataService.saveMatches(sorted as any[]);
        DataService.setSelectedEvent(eventKey);
      } else {
        // No matches returned — treat as 'not yet released'
        setMatches([]);
        DataService.setSelectedEvent(eventKey);
      }
    } catch (error) {
      console.error('Error loading matches:', error);
    } finally {
      setLoading(false);
    }
  };

  const checkAvailableEvents = async () => {
    setLoading(true);
    try {
      // Temporarily request 2026 events until the new season is published
      const year = 2026;
      const ev = await fetchEvents(year);
      if (Array.isArray(ev) && ev.length > 0) {
        setEvents(ev as Event[]);
      } else {
        // if the fetch returned nothing, keep events empty and show message
        setEvents([]);
      }
    } catch (e) {
      console.error('Failed to fetch events', e);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  const filteredEvents = events.filter(event =>
    event.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    event.key.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleEventSelect = (eventKey: string) => {
    setSelectedEvent(eventKey);
    loadMatches(eventKey);
  };

  const [showConfirmClear, setShowConfirmClear] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteInProgress, setDeleteInProgress] = useState(false);

  // Sort matches for display: first by competition level, then by match number, then by key.
  // use shared helpers from ../utils/match

  const sortedMatches = [...matches].sort(compareMatches);

  const queuedKeys = new Set(serverMatches.map((r: any) => r.key));
  const queuedLabels = serverMatches.map((r: any) => readableMatchLabel(r));
  const selectedEventName = events.find(e => e.key === selectedEvent)?.name || selectedEvent;

  return (
    <section className="cc-page">
      <div className="cc-page-titles">
        <button className="cc-back" onClick={onBack}>← Back to Admin Panel</button>
        <h1 className="cc-h1">MATCH SELECTION</h1>
      </div>

      {/* Server queued matches panel */}
      <div className="cc-card cc-banner-card">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span className="cc-eyebrow">Queued matches on server</span>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)' }}>
            {serverMatches.length === 0
              ? 'No queued matches found on server.'
              : `${serverMatches.length} matches queued · ${queuedLabels.join(', ')}`}
          </span>
        </div>
        <button
          className="cc-btn-primary"
          disabled={serverLoading}
          onClick={async () => {
            setServerLoading(true);
            try {
              await performFullRefresh({ reload: false });
              const rows = await fetchServerMatches();
              setServerMatches(rows as any[]);
            } catch (e) {
              console.error('Failed to refresh server matches', e);
              setServerMatches([]);
            } finally {
              setServerLoading(false);
            }
          }}
        >
          {serverLoading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="cc-two-col">
        {/* Events List */}
        <div className="cc-card">
          <span className="cc-eyebrow">Available events</span>

          <div className="cc-row">
            <input
              type="text"
              className="cc-input"
              placeholder="Search events…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <button
              className="cc-btn-sm-primary"
              onClick={checkAvailableEvents}
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? 'Checking…' : 'Check events'}
            </button>
          </div>

          <div className="cc-row">
            <input
              type="password"
              className="cc-input"
              value={runtimeKey}
              onChange={(e) => setRuntimeKey(e.target.value)}
              placeholder="TBA API key"
              aria-label="The Blue Alliance API key"
            />
            <button
              className="cc-btn-dark"
              onClick={() => { setRuntimeTbaKey(runtimeKey); checkAvailableEvents(); }}
            >
              Save &amp; load
            </button>
            <button
              className="cc-btn-outline"
              onClick={() => { clearRuntimeTbaKey(); setRuntimeKey(''); }}
            >
              Clear
            </button>
          </div>

          {loading ? (
            <div className="cc-empty">Loading events…</div>
          ) : (
            <div className="cc-event-list">
              {filteredEvents.map((event) => (
                <button
                  key={event.key}
                  className={`cc-event-row${selectedEvent === event.key ? ' selected' : ''}`}
                  onClick={() => handleEventSelect(event.key)}
                >
                  <span className="cc-event-name">{event.name}</span>
                  <span className="cc-event-meta">
                    {event.key} · {new Date(event.start_date).toLocaleDateString()} –{' '}
                    {new Date(event.end_date).toLocaleDateString()}
                  </span>
                </button>
              ))}
              {filteredEvents.length === 0 && (
                <div className="cc-empty">No events found matching your search.</div>
              )}
            </div>
          )}
        </div>

        {/* Matches List */}
        <div className="cc-card flush">
          <div className="cc-card-head">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <span className="cc-eyebrow">Matches {selectedEvent && `(${matches.length})`}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)' }}>
                {selectedEvent ? selectedEventName : 'No event selected'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {matches.length > 0 && (
                <button
                  className="cc-btn-grad"
                  style={{ padding: '10px 16px', fontSize: 11 }}
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    setSaveResult(null);
                    try {
                      // attach currently selected event to the matches so they are organized server-side
                      const withEvent = sortedMatches.map(m => ({ ...m, event_key: selectedEvent || DataService.getSelectedEvent() }));
                      DataService.saveMatches(withEvent as any[]);
                      // Attempt to push matches directly and report how many were synced
                      const synced = await pushMatchesToServer(withEvent as any[]);
                      // Also run migrateLocalToServer to ensure any pending scouting is pushed
                      const migrateResult = await migrateLocalToServer();
                      setSaveResult(`matches synced: ${synced}; ${migrateResult}`);
                    } catch (e: any) {
                      setSaveResult(String(e?.message || e));
                    } finally {
                      setSaving(false);
                      setTimeout(() => setSaveResult(null), 5000);
                    }
                  }}
                >
                  {saving ? 'Saving…' : 'Save matches'}
                </button>
              )}
              <button className="cc-btn-outline" onClick={() => setShowConfirmClear(true)}>
                Clear queue
              </button>
            </div>
          </div>

          {saveResult && <div className="cc-banner info" style={{ margin: '12px 20px 0' }}>{saveResult}</div>}

          {!selectedEvent ? (
            <div className="cc-empty-lg">
              <span className="cc-empty-mark">▦</span>
              <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>Select an event to view matches</span>
            </div>
          ) : matches.length === 0 ? (
            <div className="cc-empty">
              {loading ? 'Loading matches…' : 'Matches for this event are not yet released by The Blue Alliance.'}
            </div>
          ) : (
            <>
              <div className="cc-thead" style={{ gridTemplateColumns: MATCH_COLS }}>
                <span>Match</span>
                <span>Red alliance</span>
                <span>Blue alliance</span>
                <span style={{ justifySelf: 'end' }}>Queue</span>
              </div>
              <div className="cc-scroll">
                {sortedMatches.map((match) => {
                  const queued = queuedKeys.has(match.key);
                  return (
                    <div
                      key={match.key}
                      className="cc-trow"
                      style={{ gridTemplateColumns: MATCH_COLS, height: 50 }}
                      title={match.key}
                    >
                      <span style={{ fontFamily: 'var(--font-display)', fontSize: 17, letterSpacing: '0.02em' }}>
                        {readableMatchLabel(match)}
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red-600)' }}>
                        {teamList(match.alliances.red.team_keys)}
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--blue-600)' }}>
                        {teamList(match.alliances.blue.team_keys)}
                      </span>
                      <span
                        className={`cc-queue-mark${queued ? ' on' : ''}`}
                        title={queued ? 'Queued on server' : 'Not queued on server'}
                      >
                        {queued ? '✓' : '+'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {selectedEvent && matches.length > 0 && (
        <div className="cc-banner ok">
          Event selected: {selectedEventName} — {matches.length} matches loaded and ready for scouting
        </div>
      )}

      {deleteError && (
        <div className="cc-banner error" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>Failed to delete matches from server: {deleteError}</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button
              className="cc-btn-danger"
              disabled={deleteInProgress}
              onClick={async () => {
                // retry delete
                try {
                  setDeleteInProgress(true);
                  const allLocal = DataService.getMatches();
                  const keys = allLocal.map((m: any) => m.key);
                  if (keys.length > 0) await deleteMatchesFromServer(keys);
                  // success: clear local
                  DataService.clearMatches();
                  setMatches([]);
                  setSelectedEvent('');
                  setDeleteError(null);
                } catch (e: any) {
                  console.error('Retry delete failed:', e);
                  setDeleteError(String(e?.message || e));
                } finally {
                  setDeleteInProgress(false);
                }
              }}
            >
              {deleteInProgress ? 'Deleting…' : 'Retry delete'}
            </button>
            <button className="cc-btn-outline" onClick={() => setDeleteError(null)}>Dismiss</button>
          </span>
        </div>
      )}

      {showConfirmClear && (
        <div className="cc-modal-backdrop">
          <div className="cc-modal">
            <h3>CLEAR QUEUED MATCHES?</h3>
            <p>Are you sure you want to clear all queued matches for scouters? This cannot be undone.</p>
            <div className="cc-modal-actions">
              <button className="cc-btn-outline" onClick={() => setShowConfirmClear(false)}>No</button>
              <button
                className="cc-btn-danger"
                onClick={async () => {
                  try {
                    setDeleteError(null);
                    const allLocal = DataService.getMatches();
                    const keys = allLocal.map((m: any) => m.key);
                    if (keys.length > 0) {
                      await deleteMatchesFromServer(keys);
                    }
                    // clear local matches and selection on success
                    DataService.clearMatches();
                    setMatches([]);
                    setSelectedEvent('');
                    setShowConfirmClear(false);
                  } catch (e: any) {
                    // preserve local matches and surface the error
                    console.error('Failed to delete matches from server:', e);
                    setDeleteError(String(e?.message || e));
                    // keep the modal open so user can retry or cancel
                    // (do not clear local state)
                  }
                }}
              >
                Yes, clear
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// Confirmation modal component is implemented inline in the file above via state `showConfirmClear`.
