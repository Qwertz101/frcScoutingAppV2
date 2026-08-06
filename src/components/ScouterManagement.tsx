import React, { useState } from 'react';
import { Scouter } from '../types';
import { uuidv4 } from '../utils/uuid';
// DataService not required here; scouters persisted via useLocalStorage
import { useLocalStorage } from '../hooks/useLocalStorage';
import { DataService } from '../services/dataService';
import { readableMatchLabel } from '../utils/match';
import { pushScoutersToServer, performFullRefresh } from '../services/syncService';
// no direct supabase client usage here

interface ScouterManagementProps {
  onBack: () => void;
}

/**
 * Shared column track for the scouter table. The mockup specifies
 * Scouter | Alliance | Position | Mode | Remove; the app also carries a
 * "matches scouted" drill-in and an inline Edit action, so those get their
 * own tracks at the end.
 */
const SCOUTER_COLS = 'minmax(150px,2fr) 96px 110px 92px 96px 136px';

export function ScouterManagement({ onBack }: ScouterManagementProps) {
  const [scouters, setScouters] = useLocalStorage<Scouter[]>('frc-scouters', []);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [showScoutedModal, setShowScoutedModal] = useState(false);
  const [modalScouterName, setModalScouterName] = useState<string | null>(null);
  const [modalScoutedMatches, setModalScoutedMatches] = useState<Array<{ matchKey: string; label: string }>>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({
    name: '',
    alliance: 'red' as 'red' | 'blue',
    position: 1 as 1 | 2 | 3,
    isRemote: false,
  });
  const [newScouter, setNewScouter] = useState({
    name: '',
    alliance: 'red' as 'red' | 'blue',
    position: 1 as 1 | 2 | 3,
    isRemote: false,
  });

  const addScouter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newScouter.name.trim()) return;
    const scouter: Scouter = {
      id: uuidv4(),
      ...newScouter,
      name: newScouter.name.trim(),
      updatedAt: Date.now(),
      deletedAt: null,
    };

    const updated = [...scouters, scouter];
    setScouters(updated);
    // push to server and show result (await to avoid race with Sync)
    try {
      const msg = await pushScoutersToServer(updated);
      setStatusMessage(msg as string);
    } catch (err: any) {
      setStatusMessage(err?.message || String(err));
    }
    setNewScouter({ name: '', alliance: 'red', position: 1, isRemote: false });
  };

  // auto-refresh when this view loads
  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await performFullRefresh({ reload: false });
        // prefer local saved scouters (performFullRefresh will update local storage); read from DataService
        try {
          const local = DataService.getScouters() || [];
          if (mounted && Array.isArray(local) && local.length > 0) setScouters(local as any);
        } catch (e) {
          // ignore
        }
      } catch (e) {
        // ignore refresh errors
      }
    })();
    return () => { mounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openScoutedMatches = (scouterName: string) => {
    try {
      const allMatches = (DataService.getMatches() || []).filter((m: any) => !m.deletedAt);
      // use allMatches directly; totalMatches not needed here

      const scouting = DataService.getScoutingData() || [];
      const scoutedFor = scouting.filter((s: any) => (s.scouter || '').toLowerCase() === scouterName.toLowerCase());
      const matchKeys = Array.from(new Set(scoutedFor.map((s: any) => s.matchKey)));

      const mapped = matchKeys.map((mk: string) => {
        const matchInfo = allMatches.find((m: any) => m.key === mk);
        return { matchKey: mk, label: matchInfo ? readableMatchLabel(matchInfo) : mk };
      });

      setModalScouterName(scouterName);
      setModalScoutedMatches(mapped);
      setShowScoutedModal(true);
    } catch (e) {
      console.error('openScoutedMatches failed', e);
      setModalScoutedMatches([]);
      setModalScouterName(scouterName);
      setShowScoutedModal(true);
    }
  };

  const removeScouter = async (id: string) => {
    // soft delete
    const updated = scouters.map(s => s.id === id ? { ...s, deletedAt: Date.now(), updatedAt: Date.now() } : s);
    setScouters(updated);
    try {
      const msg = await pushScoutersToServer(updated);
      setStatusMessage(msg as string);
    } catch (err: any) {
      setStatusMessage(err?.message || String(err));
    }
  };

  const startEdit = (scouter: Scouter) => {
    setEditingId(scouter.id);
    setEditValues({
      name: scouter.name,
      alliance: scouter.alliance,
      position: scouter.position,
      isRemote: scouter.isRemote || false,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValues({ name: '', alliance: 'red', position: 1, isRemote: false });
  };

  const saveEdit = async (id: string) => {
    const updated = scouters.map(s => s.id === id ? { ...s, ...editValues, name: editValues.name.trim(), updatedAt: Date.now() } : s);
    setScouters(updated);
    try {
      const msg = await pushScoutersToServer(updated);
      setStatusMessage(msg as string);
    } catch (err: any) {
      setStatusMessage(err?.message || String(err));
    }
    cancelEdit();
  };

  const activeScouters = scouters.filter(s => !s.deletedAt);

  const scoutedCounts = (name: string) => {
    const selectedEvent = DataService.getSelectedEvent();
    const allMatches = (DataService.getMatches() || []).filter((m: any) => !m.deletedAt);
    const matchesForEvent = selectedEvent
      ? allMatches.filter((m: any) => !m.event_key || m.event_key === selectedEvent)
      : allMatches;
    const total = matchesForEvent.length;
    const scouting = DataService.getScoutingData() || [];
    const scoutedKeys = Array.from(new Set(
      scouting
        .filter((r: any) => (r.scouter || '').toLowerCase() === name.toLowerCase())
        .map((r: any) => r.matchKey)
    ));
    const scoutedCount = scoutedKeys.filter((k: string) => matchesForEvent.some((m: any) => m.key === k)).length;
    return { scoutedCount, total };
  };

  return (
    <section className="cc-page">
      <div className="cc-page-head">
        <div className="cc-page-titles">
          <button className="cc-back" onClick={onBack}>← Back to Admin Panel</button>
          <h1 className="cc-h1">SCOUTER MANAGEMENT</h1>
        </div>
        <button
          className="cc-btn-primary"
          disabled={isRefreshing}
          onClick={async () => {
            setStatusMessage(null);
            setIsRefreshing(true);
            try {
              await performFullRefresh({ reload: false });
              // success: show no popup; spinner will disappear
            } catch (e: any) {
              setStatusMessage(e?.message || String(e));
            } finally {
              setIsRefreshing(false);
            }
          }}
        >
          {isRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {statusMessage && (
        <div className="cc-banner info">
          <strong>Sync status:</strong> {statusMessage}
        </div>
      )}

      {/* Add New Scouter Form */}
      <div className="cc-card">
        <span className="cc-eyebrow">Add new scouter</span>
        <form onSubmit={addScouter} className="cc-form-grid">
          <div className="cc-field">
            <label className="cc-label" htmlFor="name">Name</label>
            <input
              type="text"
              id="name"
              className="cc-input"
              value={newScouter.name}
              onChange={(e) => setNewScouter({ ...newScouter, name: e.target.value })}
              placeholder="Scouter name"
              required
            />
          </div>

          <div className="cc-field">
            <label className="cc-label" htmlFor="alliance">Alliance</label>
            <select
              id="alliance"
              className="cc-select"
              value={newScouter.alliance}
              onChange={(e) => setNewScouter({ ...newScouter, alliance: e.target.value as 'red' | 'blue' })}
            >
              <option value="red">Red</option>
              <option value="blue">Blue</option>
            </select>
          </div>

          <div className="cc-field">
            <label className="cc-label" htmlFor="position">Position</label>
            <select
              id="position"
              className="cc-select"
              value={newScouter.position}
              onChange={(e) => setNewScouter({ ...newScouter, position: Number(e.target.value) as 1 | 2 | 3 })}
            >
              <option value={1}>Team 1</option>
              <option value={2}>Team 2</option>
              <option value={3}>Team 3</option>
            </select>
          </div>

          <label className="cc-check" htmlFor="isRemote" style={{ paddingBottom: 11 }}>
            <input
              type="checkbox"
              id="isRemote"
              checked={newScouter.isRemote}
              onChange={(e) => setNewScouter({ ...newScouter, isRemote: e.target.checked })}
            />
            <span>Remote</span>
          </label>

          <button type="submit" className="cc-btn-grad">+ Add</button>
        </form>
      </div>

      {/* Scouters List */}
      <div className="cc-card flush">
        <div className="cc-card-head">
          <span className="cc-eyebrow">Current scouters</span>
          <span className="cc-card-count">{activeScouters.length} assigned</span>
        </div>

        {activeScouters.length === 0 ? (
          <div className="cc-empty">No scouters assigned yet. Add some scouters above.</div>
        ) : (
          <>
            <div className="cc-thead" style={{ gridTemplateColumns: SCOUTER_COLS }}>
              <span>Scouter</span>
              <span>Alliance</span>
              <span>Position</span>
              <span>Mode</span>
              <span>Scouted</span>
              <span style={{ justifySelf: 'end' }}>Actions</span>
            </div>

            {activeScouters.map((scouter) => (
              editingId === scouter.id ? (
                <div key={scouter.id} className="cc-trow edit" style={{ gridTemplateColumns: '1fr' }}>
                  <div className="cc-row">
                    <input
                      type="text"
                      className="cc-input"
                      value={editValues.name}
                      onChange={(e) => setEditValues({ ...editValues, name: e.target.value })}
                    />
                    <select
                      className="cc-select"
                      style={{ width: 'auto' }}
                      value={editValues.alliance}
                      onChange={(e) => setEditValues({ ...editValues, alliance: e.target.value as 'red' | 'blue' })}
                    >
                      <option value="red">Red</option>
                      <option value="blue">Blue</option>
                    </select>
                    <select
                      className="cc-select"
                      style={{ width: 'auto' }}
                      value={editValues.position}
                      onChange={(e) => setEditValues({ ...editValues, position: Number(e.target.value) as 1 | 2 | 3 })}
                    >
                      <option value={1}>Team 1</option>
                      <option value={2}>Team 2</option>
                      <option value={3}>Team 3</option>
                    </select>
                    <label className="cc-check">
                      <input
                        type="checkbox"
                        checked={editValues.isRemote}
                        onChange={(e) => setEditValues({ ...editValues, isRemote: e.target.checked })}
                      />
                      <span>Remote</span>
                    </label>
                    <button className="cc-btn-sm-primary" onClick={() => saveEdit(scouter.id)}>Save</button>
                    <button className="cc-btn-outline" onClick={cancelEdit}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div key={scouter.id} className="cc-trow" style={{ gridTemplateColumns: SCOUTER_COLS }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>{scouter.name}</span>
                  <span className={`cc-tag ${scouter.alliance === 'red' ? 'red' : 'blue'}`}>
                    {scouter.alliance}
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)' }}>
                    Team {scouter.position}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: scouter.isRemote ? 'var(--teal-500)' : 'var(--text-muted)',
                    }}
                  >
                    {scouter.isRemote ? 'Remote' : 'On-site'}
                  </span>
                  <span>
                    {(() => {
                      try {
                        const { scoutedCount, total } = scoutedCounts(scouter.name);
                        return (
                          <button className="cc-link-count" onClick={() => openScoutedMatches(scouter.name)}>
                            {scoutedCount}/{total}
                          </button>
                        );
                      } catch (e) {
                        return <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>0/0</span>;
                      }
                    })()}
                  </span>
                  <span style={{ justifySelf: 'end', display: 'flex', gap: 8 }}>
                    <button className="cc-btn-del" onClick={() => startEdit(scouter)}>Edit</button>
                    <button className="cc-btn-del" onClick={() => removeScouter(scouter.id)}>Del</button>
                  </span>
                </div>
              )
            ))}
          </>
        )}
      </div>

      {showScoutedModal && (
        <div className="cc-modal-backdrop">
          <div className="cc-modal">
            <h3>MATCHES SCOUTED BY {modalScouterName}</h3>
            <div style={{ maxHeight: 256, overflowY: 'auto' }}>
              {modalScoutedMatches.length === 0 ? (
                <p>No matches scouted yet.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
                  {modalScoutedMatches.map(m => (
                    <li key={m.matchKey} style={{ padding: '3px 0' }}>
                      {m.label}{' '}
                      <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>({m.matchKey})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="cc-modal-actions">
              <button
                className="cc-btn-outline"
                onClick={() => { setShowScoutedModal(false); setModalScoutedMatches([]); setModalScouterName(null); }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
