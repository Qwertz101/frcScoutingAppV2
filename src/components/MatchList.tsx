import { Match, User } from '../types';
import { compareMatches, readableMatchLabel } from '../utils/match';
import { DataService } from '../services/dataService';
import { fetchServerScouting, performFullRefresh } from '../services/syncService';
import { useEffect, useState } from 'react';
import { getTimelines } from '../services/bpsStore';
import { ScouterHeader } from './cc/CCChrome';
import '../styles/cc.css';

interface MatchListProps {
  matches: Match[];
  user: User;
  // second arg: optional existing scouting record (local or server) mapped to local shape
  onMatchSelect: (match: Match, existing?: any) => void;
  onBack?: () => void;
  onPitScouting?: () => void;
}

export function MatchList({ matches, user, onMatchSelect, onBack, onPitScouting }: MatchListProps) {
  const getTeamForUser = (match: Match): string => {
    const alliance = match.alliances[user.alliance];
    const teamKey = alliance.team_keys[user.position - 1];
    return teamKey?.replace('frc', '') || 'Unknown';
  };

  const [, setTick] = useState(0);
  const [serverScouting, setServerScouting] = useState<any[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e) return;
      if (e.key === 'frc-scouting-data' || e.key === 'frc-pending-scouting' || e.key === 'frc-matches') {
        setTick(t => t + 1);
      }
    };
    const onServer = () => {
      // server-scouting-updated indicates matches/scouters may have changed
      setTick(t => t + 1);
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('server-scouting-updated', onServer as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('server-scouting-updated', onServer as EventListener);
    };
  }, []);

  // load server-side scouting records once (manual refresh available)
  useEffect(() => {
    let mounted = true;
    async function loadServerOnce() {
      try {
        const data = await fetchServerScouting();
        if (!mounted) return;
        setServerScouting(Array.isArray(data) ? data : []);
      } catch (e) {
        // ignore fetch errors; we'll fall back to local-only
        // eslint-disable-next-line no-console
        console.warn('MatchList: failed to fetch server scouting', e);
        setServerScouting([]);
      }
    }

    loadServerOnce();
    return () => { mounted = false; };
  }, []);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      // manual refresh: run the canonical full refresh without reloading the page
      await performFullRefresh({ reload: false });
      // ensure we also refresh any cached server scouting rows the component uses
      const data = await fetchServerScouting();
      setServerScouting(Array.isArray(data) ? data : []);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('MatchList: manual refresh failed', e);
    } finally {
      setIsRefreshing(false);
    }
  };

  const localScouting = DataService.getScoutingData() || [];
  // Live Match writes timelines through bpsStore, not DataService, so "✓ Done"
  // has to consult both stores to keep working for records from either era.
  const timelines = getTimelines();
  // consider a match scouted for this user if either local or server contains a record
  const isScoutedByUser = (m: Match) => {
    const timelineHit = timelines.some((t) => t.matchKey === m.key && t.scouter === user.username);
    if (timelineHit) return true;
    const localHit = localScouting.some((s: any) => s.matchKey === m.key && s.scouter === user.username);
    if (localHit) return true;
    // check server records (match_key / scouter_name)
    const serverHit = serverScouting.some((r: any) => (r.match_key === m.key || r.match_key === m.key) && (r.scouter_name === user.username));
    return !!serverHit;
  };
  const sorted = matches.slice().sort(compareMatches);
  const unscouted = sorted.filter(m => !isScoutedByUser(m));
  const scouted = sorted.filter(m => isScoutedByUser(m));
  const orderedMatches = [...unscouted, ...scouted];

  const openMatch = (match: Match) => {
    // attempt to find existing record for this scouter
    const timeline = timelines.find((t) => t.matchKey === match.key && t.scouter === user.username);
    if (timeline) {
      onMatchSelect(match, timeline);
      return;
    }
    const localScouting = DataService.getScoutingData() || [];
    const local = localScouting.find((s: any) => s.matchKey === match.key && s.scouter === user.username);
    if (local) {
      onMatchSelect(match, local);
      return;
    }
    // check server records fetched earlier
    const server = serverScouting.find((r: any) => (r.match_key === match.key || r.match_key === match.key) && r.scouter_name === user.username);
    if (server) {
      const mapped = {
        id: server.id,
        matchKey: server.match_key,
        teamKey: server.team_key,
        scouter: server.scouter_name,
        alliance: server.alliance,
        position: server.position,
        auto: {
          ...(server.payload?.auto || { l1: 0, l2: 0, l3: 0, l4: 0, hasAuto: false }),
          net: typeof server.payload?.auto?.net === 'number' ? server.payload.auto.net : (server.payload?.auto?.net ? 1 : 0),
          prosser: typeof server.payload?.auto?.prosser === 'number' ? server.payload.auto.prosser : (server.payload?.auto?.prosser ? 1 : 0),
        },
        teleop: {
          ...(server.payload?.teleop || { l1: 0, l2: 0, l3: 0, l4: 0 }),
          net: typeof server.payload?.teleop?.net === 'number' ? server.payload.teleop.net : (server.payload?.teleop?.net ? 1 : 0),
          prosser: typeof server.payload?.teleop?.prosser === 'number' ? server.payload.teleop.prosser : (server.payload?.teleop?.prosser ? 1 : 0),
        },
        endgame: server.payload?.endgame || { climb: 'none' },
        defense: server.payload?.defense || 'none',
        timestamp: server.timestamp ? Date.parse(server.timestamp) : Date.now(),
      };
      onMatchSelect(match, mapped);
      return;
    }
    onMatchSelect(match);
  };

  const eventKey = DataService.getSelectedEvent();
  const subtitle = `Rebuilt · ${eventKey ? eventKey.toUpperCase() : 'no event selected'}`;
  const assignment = `${user.alliance.toUpperCase()} ${user.position}`;

  // match labeling handled by shared helper

  return (
    <div className="cc-root">
      <ScouterHeader
        user={user.username}
        assignment={assignment}
        alliance={user.alliance === 'blue' ? 'blue' : 'red'}
        subtitle={subtitle}
        onRefresh={handleRefresh}
        onLogout={() => { if (onBack) onBack(); }}
        action={
          <button className="cc-header-primary" onClick={() => { if (onPitScouting) onPitScouting(); }}>
            Pit Scouting
          </button>
        }
      />

      <section className="cc-page" style={{ padding: '22px 20px 40px', gap: 14 }}>
        <h1 className="cc-h1 sm">MATCH SCHEDULE</h1>

        {isRefreshing && <div className="cc-banner info">Refreshing…</div>}

        {orderedMatches.map((match) => {
          const done = isScoutedByUser(match);
          return (
            <div
              key={match.key}
              role="button"
              tabIndex={0}
              onClick={() => openMatch(match)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMatch(match); } }}
              className={`cc-match-card${done ? ' done' : ''}`}
            >
              <div className="cc-match-top">
                <div className="cc-match-id">
                  <span className="cc-match-name">
                    <span>{readableMatchLabel(match)}</span>
                    {done && <span className="cc-done-tag" title="Scouted">✓ Done</span>}
                  </span>
                  <span className="cc-match-sub">◷ Match {match.match_number}</span>
                </div>
                <div className="cc-match-assign">
                  <span className={`cc-match-team${user.alliance === 'blue' ? ' blue' : ''}`}>
                    Team {getTeamForUser(match)}
                  </span>
                  <span className="cc-match-role">Your assignment</span>
                </div>
              </div>

              <div className="cc-match-grid">
                <div className="cc-alliance red">
                  <span className="cc-alliance-title">Red Alliance</span>
                  {match.alliances.red.team_keys.map((teamKey, index) => (
                    <span
                      key={teamKey}
                      className={`cc-alliance-team${user.alliance === 'red' && user.position === index + 1 ? ' me' : ''}`}
                    >
                      {index + 1}. {teamKey.replace('frc', '')}
                    </span>
                  ))}
                </div>

                <div className="cc-alliance blue">
                  <span className="cc-alliance-title">Blue Alliance</span>
                  {match.alliances.blue.team_keys.map((teamKey, index) => (
                    <span
                      key={teamKey}
                      className={`cc-alliance-team${user.alliance === 'blue' && user.position === index + 1 ? ' me' : ''}`}
                    >
                      {index + 1}. {teamKey.replace('frc', '')}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          );
        })}

        {matches.length === 0 && (
          <div className="cc-card">
            <div className="cc-empty-lg">
              <span className="cc-empty-mark">◷</span>
              <h3 className="cc-h1 sm">NO MATCHES AVAILABLE</h3>
              <p className="cc-lede">Contact your admin to select an event and load matches.</p>
              {onBack && (
                <button className="cc-btn-outline" onClick={onBack}>
                  Back to Login
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
