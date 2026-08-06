import { useMemo, useState, useEffect, useRef } from 'react';
import { DataService } from '../services/dataService';
import { fetchPitData, listPitImages } from '../services/syncService';
import { User } from '../types';
import { ScouterHeader } from './cc/CCChrome';
import '../styles/cc.css';

type PitForm = {
  underTrench: boolean;
  climbLevel: 'cannot' | 'level1' | 'level2' | 'level3';
  climbPositions: { side: boolean; pillar: boolean; center: boolean };
  hasAuto: boolean;
  canClimbInAuto: boolean;
  autoTypes: { outpost_side: boolean; center: boolean; depot_side: boolean };
};

const emptyForm: PitForm = {
  underTrench: false,
  climbLevel: 'cannot',
  climbPositions: { side: false, pillar: false, center: false },
  hasAuto: false,
  canClimbInAuto: false,
  autoTypes: { outpost_side: false, center: false, depot_side: false },
};

interface PitScoutingProps {
  onBack: () => void;
  /** Optional: drives the shared scouter header badge. */
  user?: User;
  onLogout?: () => void;
}

export function PitScouting({ onBack, user, onLogout }: PitScoutingProps) {
  const matches = (DataService.getMatches() || []).filter((m: any) => !m.deletedAt);
  const [manualTeams, setManualTeams] = useState(() => DataService.getTeams());
  const [serverPitTeams, setServerPitTeams] = useState<string[]>([]);

  const teams = useMemo(() => {
    const set = new Set<string>();
    matches.forEach((m: any) => {
      ['red', 'blue'].forEach((a) => {
        (m.alliances?.[a]?.team_keys || []).forEach((tk: string) => set.add(tk));
      });
    });
    // include manual teams
    manualTeams.forEach(t => set.add(t.teamKey));
    // include teams discovered from server-side pit_data rows
    serverPitTeams.forEach(tk => set.add(tk));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [matches, manualTeams]);

  const [newTeamNumber, setNewTeamNumber] = useState<string>('');
  const [newTeamName, setNewTeamName] = useState<string>('');

  const loadServerPitTeams = async () => {
    try {
      const rows: any[] = await fetchPitData();
      const keys = (rows || []).map(r => r.team_key).filter(Boolean);
      setServerPitTeams(keys);
    } catch (e) {
      // ignore fetch errors
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const rows: any[] = await fetchPitData();
        if (!mounted) return;
        const keys = (rows || []).map(r => r.team_key).filter(Boolean);
        setServerPitTeams(keys);
      } catch (e) {
        // ignore fetch errors
      }
    })();
    return () => { mounted = false; };
  }, []);

  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [form, setForm] = useState<PitForm>(emptyForm);
  const [images, setImages] = useState<string[]>([]);
  const [notes, setNotes] = useState<string>('');
  const [showCamera, setShowCamera] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!selectedTeam) return;
    const saved = DataService.getPitData(selectedTeam);
    if (saved) {
      setForm({ ...emptyForm, ...saved });
      setNotes(saved.notes || '');
    } else {
      setForm(emptyForm);
    }
    // attempt to load images from Supabase storage for this team; fall back to local images
    (async () => {
      try {
        const urls = await listPitImages(selectedTeam);
        if (urls && urls.length > 0) {
          setImages(urls);
          return;
        }
      } catch (e) {
        // ignore storage listing errors
      }
      try {
        const imgs = DataService.getPitImages(selectedTeam);
        setImages(imgs || []);
      } catch (e) {
        setImages([]);
      }
    })();
  }, [selectedTeam]);

  const save = () => {
    if (!selectedTeam) return;
    DataService.savePitData(selectedTeam, { ...(form as any), notes });
    // persist images separately
    try {
      DataService.savePitImages(selectedTeam, images);
    } catch (e) {}
    // simple feedback could be added
    setSelectedTeam(null);
  };

  const savedPit = DataService.getPitData() || {};
  const eventKey = DataService.getSelectedEvent();
  const subtitle = `Pit Scouting · ${eventKey ? eventKey.toUpperCase() : 'no event selected'}`;
  const assignment = user ? `${user.alliance.toUpperCase()} ${user.position}` : 'PIT';
  const alliance: 'red' | 'blue' = user?.alliance === 'blue' ? 'blue' : 'red';

  return (
    <div className="cc-root">
      <ScouterHeader
        user={user?.username || 'Scouter'}
        assignment={assignment}
        alliance={alliance}
        subtitle={subtitle}
        onRefresh={() => { setManualTeams(DataService.getTeams()); loadServerPitTeams(); }}
        onLogout={() => { if (onLogout) onLogout(); else onBack(); }}
        action={
          <button className="cc-header-ghost" onClick={onBack}>
            Back to Matches
          </button>
        }
      />

      {!selectedTeam ? (
        <section className="cc-page" style={{ padding: '22px 20px 40px', gap: 16 }}>
          <h1 className="cc-h1 sm">PIT SCOUTING</h1>

          <div className="cc-pit-bar">
            <input
              className="cc-input"
              value={newTeamNumber}
              onChange={(e) => setNewTeamNumber(e.target.value)}
              placeholder="Team number (e.g. 254)"
            />
            <input
              className="cc-input"
              value={newTeamName}
              onChange={(e) => setNewTeamName(e.target.value)}
              placeholder="Nickname (optional)"
            />
            <button
              className="cc-btn-grad"
              style={{ padding: '11px 20px', fontSize: 12 }}
              onClick={() => {
                const raw = newTeamNumber.trim();
                if (!raw) return;
                const key = raw.startsWith('frc') ? raw : `frc${raw}`;
                DataService.addTeam(key, newTeamName.trim() || undefined);
                // reset inputs and refresh by forcing state change
                setNewTeamNumber(''); setNewTeamName('');
                setManualTeams(DataService.getTeams());
                // select the newly added team immediately for quick scouting
                setSelectedTeam(key);
              }}
            >
              Add Team
            </button>
            {manualTeams.length > 0 && (
              <div className="cc-pit-note">
                Manual teams: {manualTeams.map(t => t.teamKey.replace(/^frc/, '')).join(', ')}
              </div>
            )}
          </div>

          {teams.length === 0 ? (
            <div className="cc-card">
              <div className="cc-empty-lg">
                <span className="cc-empty-mark">◈</span>
                <p className="cc-lede">No teams yet — add one above or load an event's matches.</p>
              </div>
            </div>
          ) : (
            <div className="cc-team-grid">
              {teams.map(t => {
                const manual = manualTeams.find(mt => mt.teamKey === t);
                const done = !!savedPit[t];
                return (
                  <div
                    key={t}
                    role="button"
                    tabIndex={0}
                    className="cc-team-card"
                    onClick={() => setSelectedTeam(t)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedTeam(t); } }}
                  >
                    <span className="cc-team-id">
                      <span className="cc-team-num">{t.replace(/^frc/, '')}</span>
                      {manual?.name && <span className="cc-team-name">{manual.name}</span>}
                    </span>
                    <span className="cc-team-meta">
                      {done && <span className="cc-done-tag">✓ Done</span>}
                      {manual && (
                        <button
                          className="cc-team-del"
                          title="Remove manual team"
                          onClick={(e) => {
                            e.stopPropagation();
                            DataService.removeTeam(t);
                            setManualTeams(DataService.getTeams());
                            setSelectedTeam(null);
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ) : (
        <section className="cc-page" style={{ padding: '22px 20px 40px', gap: 16 }}>
          <div className="cc-actionbar">
            <div className="cc-actionbar-left">
              <button className="cc-btn-icon" onClick={() => setSelectedTeam(null)} title="Back to teams">←</button>
              <h1 className="cc-actionbar-title">TEAM {selectedTeam.replace(/^frc/, '')} — PIT SCOUTING</h1>
            </div>
            <div className="cc-actionbar-actions">
              <button className="cc-btn-warn" onClick={() => { setForm(emptyForm); }}>Reset</button>
              <button className="cc-btn-save" onClick={save}>Save</button>
            </div>
          </div>

          <div className="cc-q-grid">
            <div className="cc-q-card">
              <span className="cc-q-title">Can the robot go under the trench?</span>
              <div className="cc-q-radios">
                <label className="cc-check">
                  <input type="radio" name="underTrench" checked={form.underTrench === true} onChange={() => setForm(f => ({ ...f, underTrench: true }))} />
                  <span>Yes</span>
                </label>
                <label className="cc-check">
                  <input type="radio" name="underTrench" checked={form.underTrench === false} onChange={() => setForm(f => ({ ...f, underTrench: false }))} />
                  <span>No</span>
                </label>
              </div>
            </div>

            <div className="cc-q-card">
              <span className="cc-q-title">What level can the robot climb to?</span>
              <select
                className="cc-select"
                value={form.climbLevel}
                onChange={(e) => setForm(f => ({ ...f, climbLevel: e.target.value as any }))}
              >
                <option value="cannot">Cannot climb</option>
                <option value="level1">Level 1</option>
                <option value="level2">Level 2</option>
                <option value="level3">Level 3</option>
              </select>
            </div>

            <div className="cc-q-card">
              <span className="cc-q-title">Positions the robot can climb from (select all that apply)</span>
              <div className="cc-q-checks">
                <label className="cc-check">
                  <input type="checkbox" checked={form.climbPositions.side} onChange={(e) => setForm(f => ({ ...f, climbPositions: { ...f.climbPositions, side: e.target.checked } }))} />
                  <span>Side</span>
                </label>
                <label className="cc-check">
                  <input type="checkbox" checked={form.climbPositions.pillar} onChange={(e) => setForm(f => ({ ...f, climbPositions: { ...f.climbPositions, pillar: e.target.checked } }))} />
                  <span>Pillar</span>
                </label>
                <label className="cc-check">
                  <input type="checkbox" checked={form.climbPositions.center} onChange={(e) => setForm(f => ({ ...f, climbPositions: { ...f.climbPositions, center: e.target.checked } }))} />
                  <span>Center</span>
                </label>
              </div>
            </div>

            <div className="cc-q-card">
              <span className="cc-q-title">Does the robot have an auto?</span>
              <div className="cc-q-radios">
                <label className="cc-check">
                  <input type="radio" name="hasAuto" checked={form.hasAuto === true} onChange={() => setForm(f => ({ ...f, hasAuto: true }))} />
                  <span>Yes</span>
                </label>
                <label className="cc-check">
                  <input type="radio" name="hasAuto" checked={form.hasAuto === false} onChange={() => setForm(f => ({ ...f, hasAuto: false }))} />
                  <span>No</span>
                </label>
              </div>
            </div>

            <div className="cc-q-card">
              <span className="cc-q-title">Can the robot climb in auto?</span>
              <div className="cc-q-radios">
                <label className="cc-check">
                  <input type="radio" name="canClimbInAuto" checked={form.canClimbInAuto === true} onChange={() => setForm(f => ({ ...f, canClimbInAuto: true }))} />
                  <span>Yes</span>
                </label>
                <label className="cc-check">
                  <input type="radio" name="canClimbInAuto" checked={form.canClimbInAuto === false} onChange={() => setForm(f => ({ ...f, canClimbInAuto: false }))} />
                  <span>No</span>
                </label>
              </div>
            </div>

            <div className="cc-q-card">
              <span className="cc-q-title">Type of auto (select all that apply)</span>
              <div className="cc-q-checks">
                <label className="cc-check">
                  <input type="checkbox" checked={form.autoTypes.outpost_side} onChange={(e) => setForm(f => ({ ...f, autoTypes: { ...f.autoTypes, outpost_side: e.target.checked } }))} />
                  <span>Outpost side</span>
                </label>
                <label className="cc-check">
                  <input type="checkbox" checked={form.autoTypes.center} onChange={(e) => setForm(f => ({ ...f, autoTypes: { ...f.autoTypes, center: e.target.checked } }))} />
                  <span>Center</span>
                </label>
                <label className="cc-check">
                  <input type="checkbox" checked={form.autoTypes.depot_side} onChange={(e) => setForm(f => ({ ...f, autoTypes: { ...f.autoTypes, depot_side: e.target.checked } }))} />
                  <span>Depot side</span>
                </label>
              </div>
            </div>

            <div className="cc-q-card wide split">
              <span className="cc-q-title">Robot Photos</span>
              <div className="cc-photo-actions">
                <button className="cc-btn-icon" title="Open camera" onClick={() => setShowCamera(true)}>◎</button>
                <button className="cc-btn-outline" title="Add from device" onClick={() => fileInputRef.current?.click()}>Add</button>
                <input ref={fileInputRef} type="file" accept="image/*" capture="environment" multiple style={{ display: 'none' }} onChange={(e) => {
                  const files = e.target.files; if (!files) return;
                  Array.from(files).forEach(f => {
                    const reader = new FileReader();
                    reader.onload = () => {
                      if (typeof reader.result === 'string') {
                        setImages(prev => {
                          const next = [...prev, reader.result as string];
                          return next;
                        });
                        // persist immediately
                        try { if (selectedTeam) DataService.savePitImages(selectedTeam, [...DataService.getPitImages(selectedTeam), reader.result as string]); } catch (e) {}
                      }
                    };
                    reader.readAsDataURL(f);
                  });
                  // clear input to allow re-selecting same file
                  e.currentTarget.value = '';
                }} />
              </div>

              {images.length > 0 && (
                <div className="cc-photo-row">
                  {images.map((src, idx) => (
                    <div key={idx} className="cc-thumb">
                      <img src={src} alt={`robot-${idx}`} />
                      <button
                        className="cc-thumb-del"
                        onClick={() => { setImages(prev => { const n = [...prev]; n.splice(idx, 1); if (selectedTeam) DataService.savePitImages(selectedTeam, n); return n; }); }}
                      >
                        Del
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="cc-q-card wide">
              <span className="cc-q-title">Scouter Notes</span>
              <textarea
                className="cc-textarea"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                placeholder="Anything notable about the robot (drive, quirks, components, etc.)"
              />
            </div>
          </div>

          {showCamera && (
            <div className="cc-modal-backdrop">
              <div className="cc-modal" style={{ maxWidth: 520 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <h3>CAMERA</h3>
                  <button
                    className="cc-btn-outline"
                    onClick={() => {
                      // stop stream
                      if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
                      setShowCamera(false);
                    }}
                  >
                    Close
                  </button>
                </div>
                <video ref={videoRef} className="cc-camera-video" autoPlay playsInline />
                <div className="cc-modal-actions" style={{ justifyContent: 'flex-start' }}>
                  <button
                    className="cc-btn-primary"
                    onClick={async () => {
                      try {
                        if (!streamRef.current) {
                          const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
                          streamRef.current = s;
                          if (videoRef.current) videoRef.current.srcObject = s;
                          // wait a short moment for camera to warm
                          await new Promise(r => setTimeout(r, 200));
                        }
                        // capture frame
                        const v = videoRef.current;
                        if (!v) return;
                        const canvas = document.createElement('canvas');
                        canvas.width = v.videoWidth || 1280;
                        canvas.height = v.videoHeight || 720;
                        const ctx = canvas.getContext('2d');
                        if (!ctx) return;
                        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
                        const data = canvas.toDataURL('image/jpeg', 0.8);
                        setImages(prev => {
                          const next = [...prev, data];
                          try { if (selectedTeam) DataService.savePitImages(selectedTeam, next); } catch (e) {}
                          return next;
                        });
                      } catch (e) {
                        // ignore
                      }
                    }}
                  >
                    Take Photo
                  </button>
                  <button
                    className="cc-btn-outline"
                    onClick={() => {
                      // stop stream but keep modal open
                      if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
                    }}
                  >
                    Stop Camera
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
