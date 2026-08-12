import { useState, useEffect } from 'react';
import { User, Match } from './types';
import { DataService } from './services/dataService';
import { performFullRefresh } from './services/syncService';
import { LoginPage } from './components/LoginPage';
import { MatchList } from './components/MatchList';
import { LiveMatch } from './components/LiveMatch';
import { AdminPanel } from './components/AdminPanel';
import { PitScouting } from './components/PitScouting';

type AppState = 'login' | 'matches' | 'scouting' | 'admin' | 'pit';

function App() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  // detect newly waiting service worker and prompt user to activate it
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      if (reg.waiting) {
        setWaitingWorker(reg.waiting);
        setUpdateAvailable(true);
      }
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && reg.waiting) {
            setWaitingWorker(reg.waiting);
            setUpdateAvailable(true);
          }
        });
      });
    });
    // listen for controllerchange to clear the update flag when active
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      setUpdateAvailable(false);
      setWaitingWorker(null);
    });
  }, []);

  // show a one-time cleanup success popup if present after a Force Refresh
  const [cleanupSummary, setCleanupSummary] = useState<{ removed: number; fixed: number; pendingRemoved: number } | null>(null);
  useEffect(() => {
    try {
      const ok = localStorage.getItem('frc-cleanup-success');
      if (ok) {
        const raw = localStorage.getItem('frc-cleanup-summary');
        if (raw) {
          const obj = JSON.parse(raw);
          setCleanupSummary({ removed: obj.removed || 0, fixed: obj.fixed || 0, pendingRemoved: obj.pendingRemoved || 0 });
        } else {
          setCleanupSummary({ removed: 0, fixed: 0, pendingRemoved: 0 });
        }
        // clear the flags so we only show once
        localStorage.removeItem('frc-cleanup-success');
        localStorage.removeItem('frc-cleanup-summary');
      }
    } catch (e) {
      // ignore
    }
  }, []);

  const activateUpdate = () => {
    if (!waitingWorker) return;
    try {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    } catch (e) {}
  };
  const [currentState, setCurrentState] = useState<AppState>('login');
  const [user, setUser] = useState<User | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<Match | null>(null);
  const [selectedScouting, setSelectedScouting] = useState<any | null>(null);

  useEffect(() => {
    // Register service worker for PWA
    if ('serviceWorker' in navigator) {
      const swUrl = (import.meta as any).env?.BASE_URL ? `${(import.meta as any).env.BASE_URL}sw.js` : '/sw.js';
      navigator.serviceWorker.register(swUrl)
        .then(() => console.log('SW registered at', swUrl))
        .catch(console.error);
    }

    // Load matches from storage (exclude deleted matches)
    const storedMatches = (DataService.getMatches() || []).filter((m: any) => !m.deletedAt);
    setMatches(storedMatches);

    const onServer = () => {
      const s = (DataService.getMatches() || []).filter((m: any) => !m.deletedAt);
      setMatches(s);
    };
    window.addEventListener('server-scouting-updated', onServer as EventListener);
    window.addEventListener('storage', (e) => { if (e.key === 'frc-matches') onServer(); });
  }, []);

  // Ensure matches are reloaded whenever we transition to the matches view (e.g., after logout/login or role switch)
  useEffect(() => {
    if (currentState === 'matches') {
      const stored = DataService.getMatches();
      setMatches(stored);
    }
  }, [currentState]);

  const handleLogin = async (userData: User) => {
    setUser(userData);
    try {
      // Ensure we pull authoritative server state before showing matches so
      // scouters see latest assignments. This also syncs this device's
      // selected event from whichever one the admin has marked current on
      // the server — the admin is the only one who ever calls
      // DataService.setSelectedEvent locally (from Match Selection), so a
      // scouter's device would otherwise never have one set at all, and
      // every event-scoped read falls back to "show everything" (e.g. two
      // different events' Qualification 1 on one Match Schedule).
      await performFullRefresh({ reload: false });
    } catch (e) {
      // ignore errors but continue to show UI
      // eslint-disable-next-line no-console
      console.warn('handleLogin: performFullRefresh failed', e);
    }
    if (userData.isAdmin) {
      setCurrentState('admin');
    } else {
      // reload matches from storage (exclude deleted)
      const stored = (DataService.getMatches() || []).filter((m: any) => !m.deletedAt);
      setMatches(stored as Match[]);
      setCurrentState('matches');
    }
  };

  const handleLogout = () => {
    setUser(null);
    setSelectedMatch(null);
    setCurrentState('login');
  };

  const handleMatchSelect = (match: Match, existing?: any) => {
    setSelectedMatch(match);
    setSelectedScouting(existing || null);
    setCurrentState('scouting');
  };

  const handlePitScouting = () => {
    setCurrentState('pit');
  };

  const handleScoutingComplete = () => {
    setSelectedMatch(null);
    setSelectedScouting(null);
    setCurrentState('matches');
    // Reload matches in case they were updated
    const storedMatches = DataService.getMatches();
    setMatches(storedMatches);
  };

  const handleBackToMatches = () => {
    setSelectedMatch(null);
    setCurrentState('matches');
  };

  if (currentState === 'login') {
    return <LoginPage onLogin={handleLogin} />;
  }

  // show update banner across app if update is available
  const maybeUpdateBanner = updateAvailable ? (
    <div className="fixed bottom-4 right-4 z-50">
      <div className="bg-yellow-400 text-black rounded px-4 py-2 shadow">New version available — <button onClick={activateUpdate} className="underline font-semibold">Activate & reload</button></div>
    </div>
  ) : null;

  if (currentState === 'admin' && user?.isAdmin) {
    return <AdminPanel user={user} onLogout={handleLogout} />;
  }

  if (currentState === 'scouting' && selectedMatch && user) {
    return (
      <LiveMatch
        match={selectedMatch}
        user={user}
        onBack={handleBackToMatches}
        existing={selectedScouting}
        onSubmit={handleScoutingComplete}
      />
    );
  }

  if (currentState === 'matches' && user) {
    return (
      <>
            <MatchList
              matches={matches}
              user={user}
              onMatchSelect={handleMatchSelect}
              onBack={handleLogout}
              onPitScouting={handlePitScouting}
            />
        {cleanupSummary && (
          <div className="fixed bottom-6 left-6 z-50">
            <div className="bg-green-600 text-white rounded px-4 py-3 shadow-lg">
              <div className="font-semibold">Update applied</div>
              <div className="text-sm">Cleaned {cleanupSummary.removed} malformed rows, fixed {cleanupSummary.fixed} records, removed {cleanupSummary.pendingRemoved} invalid pending ids.</div>
              <div className="mt-2 text-right">
                <button onClick={() => setCleanupSummary(null)} className="underline">Dismiss</button>
              </div>
            </div>
          </div>
        )}
        {maybeUpdateBanner}
      </>
    );
  }

  if (currentState === 'pit' && user) {
    return (
      <PitScouting onBack={() => setCurrentState('matches')} user={user} onLogout={handleLogout} />
    );
  }

  return <LoginPage onLogin={handleLogin} />;
}

export default App;