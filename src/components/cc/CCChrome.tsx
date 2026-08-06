import { useState, ReactNode } from 'react';
import { performFullRefresh, fetchServerScouters } from '../../services/syncService';
import '../../styles/cc.css';

/**
 * Shared Charging Champions chrome — the bolt mark, the black app header, and
 * the sync indicator that used to live in SyncControl.
 *
 * The mockups draw the bolt as `assets/logo-bolt.png`. We render it as inline
 * SVG instead so it stays crisp at any size and ships no binary asset, which is
 * the same choice the Scout workspace header already made.
 */
export const BoltMark = () => (
  <svg className="cc-bolt" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="cc-bolt-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#00baff" />
        <stop offset="100%" stopColor="#1179ee" />
      </linearGradient>
    </defs>
    <path d="M13.5 2 4 13.5h6L9.5 22 20 10h-6.5z" fill="url(#cc-bolt-grad)" />
  </svg>
);

export type SyncState = 'idle' | 'working' | 'ok' | 'error';

/**
 * Drives the header's dot + label. Replaces SyncControl's inline status text:
 * the same three actions (sync, check, refresh) now report through one dot.
 */
export function useSyncStatus() {
  const [state, setState] = useState<SyncState>('idle');
  const [label, setLabel] = useState('Idle');

  const run = async (fn: () => Promise<unknown> | unknown, okLabel: string) => {
    setState('working');
    setLabel('Syncing…');
    try {
      const res = await fn();
      setState('ok');
      setLabel(Array.isArray(res) ? `${okLabel} · ${res.length}` : okLabel);
      // Fall back to Idle so a stale "Synced" never reads as current.
      setTimeout(() => {
        setState('idle');
        setLabel('Idle');
      }, 4000);
    } catch (e: any) {
      console.error('Sync failed', e);
      setState('error');
      setLabel(e?.message ? String(e.message) : 'Sync failed');
      setTimeout(() => {
        setState('idle');
        setLabel('Idle');
      }, 5000);
    }
  };

  return { state, label, run, busy: state === 'working' };
}

interface SyncIndicatorProps {
  state: SyncState;
  label: string;
}

export function SyncIndicator({ state, label }: SyncIndicatorProps) {
  return (
    <span className="cc-sync">
      <span className={`cc-sync-dot${state === 'idle' ? '' : ` ${state}`}`} />
      <span className="cc-sync-label">{label}</span>
    </span>
  );
}

export type AdminTab = 'menu' | 'scouters' | 'matches';

interface AdminHeaderProps {
  tab: AdminTab;
  onNavigate: (tab: AdminTab) => void;
  onLogout: () => void;
  /** Event key shown in the brand sub-line, e.g. "2026caven". */
  eventKey?: string | null;
  ourTeam?: number;
}

/**
 * The black header shared by every admin screen. Sync / Check live here now,
 * so the old standalone SyncControl block is gone from the page body.
 */
export function AdminHeader({
  tab,
  onNavigate,
  onLogout,
  eventKey,
  ourTeam = 6560,
}: AdminHeaderProps) {
  const sync = useSyncStatus();

  return (
    <header className="cc-header">
      <div className="cc-brand">
        <BoltMark />
        <div className="cc-brand-text">
          <span className="cc-brand-name">SCOUT {ourTeam}</span>
          <span className="cc-brand-sub">
            Admin · {eventKey ? eventKey.toUpperCase() : 'no event selected'}
          </span>
        </div>
      </div>

      <nav className="cc-nav">
        <button
          className={`cc-nav-btn${tab === 'menu' ? ' active' : ''}`}
          onClick={() => onNavigate('menu')}
        >
          Admin Panel
        </button>
        <button
          className={`cc-nav-btn${tab === 'scouters' ? ' active' : ''}`}
          onClick={() => onNavigate('scouters')}
        >
          Scouters
        </button>
        <button
          className={`cc-nav-btn${tab === 'matches' ? ' active' : ''}`}
          onClick={() => onNavigate('matches')}
        >
          Match Selection
        </button>
      </nav>

      <div className="cc-header-spacer" />

      <div className="cc-header-right">
        <SyncIndicator state={sync.state} label={sync.label} />
        <button
          className="cc-pill-btn"
          disabled={sync.busy}
          onClick={() => sync.run(() => performFullRefresh({ reload: false }), 'Synced just now')}
        >
          Sync
        </button>
        <button
          className="cc-pill-ghost"
          disabled={sync.busy}
          onClick={() =>
            sync.run(async () => {
              await performFullRefresh({ reload: false });
              return fetchServerScouters();
            }, 'Server scouters')
          }
        >
          Check
        </button>
        <button className="cc-logout" onClick={onLogout}>
          Logout
        </button>
      </div>
    </header>
  );
}

interface ScouterHeaderProps {
  user: string;
  /** "RED 1" / "BLUE 3" — the scouter's seat for the event. */
  assignment: string;
  alliance: 'red' | 'blue';
  subtitle: string;
  onRefresh: () => void;
  onLogout: () => void;
  /** Right-hand action: Pit Scouting on the schedule, Back elsewhere. */
  action: ReactNode;
}

/** The scouter-side header: no nav tabs, but a standing assignment badge. */
export function ScouterHeader({
  user,
  assignment,
  alliance,
  subtitle,
  onRefresh,
  onLogout,
  action,
}: ScouterHeaderProps) {
  return (
    <header className="cc-header">
      <div className="cc-brand">
        <BoltMark />
        <div className="cc-brand-text">
          <span className="cc-brand-name">SCOUT 6560</span>
          <span className="cc-brand-sub">{subtitle}</span>
        </div>
      </div>

      <div className="cc-header-user">
        <span className="cc-header-user-mark">◈</span>
        <span>{user}</span>
      </div>

      <div className="cc-header-spacer" />

      <div className="cc-header-right">
        {action}
        <button className="cc-header-ghost" onClick={onRefresh}>
          Refresh
        </button>
        <span className={`cc-assignment${alliance === 'blue' ? ' blue' : ''}`}>{assignment}</span>
        <button className="cc-logout" onClick={onLogout}>
          Logout
        </button>
      </div>
    </header>
  );
}
