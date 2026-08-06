import { useState } from 'react';
import { User } from '../types';
import { ScouterManagement } from './ScouterManagement';
import { performFullRefresh, fetchServerScouters } from '../services/syncService';
import { DataService } from '../services/dataService';
import { MatchSelection } from './MatchSelection';
import { ScoutShell } from './scout/ScoutShell';
import { AdminHeader, AdminTab } from './cc/CCChrome';
import '../styles/cc.css';

interface AdminPanelProps {
  user: User;
  onLogout: () => void;
}

/**
 * `picklist` is not an AdminTab: the Scout workspace takes over the whole
 * viewport with its own header, so it sits outside the admin chrome.
 */
type AdminView = AdminTab | 'picklist';

export function AdminPanel({ user, onLogout }: AdminPanelProps) {
  const [view, setView] = useState<AdminView>('menu');
  const eventKey = DataService.getSelectedEvent();

  if (view === 'picklist') {
    return <ScoutShell onBack={() => setView('menu')} />;
  }

  const chrome = (body: React.ReactNode) => (
    <div className="cc-root">
      <AdminHeader
        tab={view as AdminTab}
        onNavigate={setView}
        onLogout={onLogout}
        eventKey={eventKey}
      />
      {body}
    </div>
  );

  if (view === 'scouters') {
    return chrome(<ScouterManagement onBack={() => setView('menu')} />);
  }

  if (view === 'matches') {
    return chrome(<MatchSelection onBack={() => setView('menu')} />);
  }

  return chrome(
    <section className="cc-page">
      <div className="cc-page-head">
        <div className="cc-page-titles">
          <span className="cc-eyebrow">Signed in as {user.username}</span>
          <h1 className="cc-h1">ADMIN PANEL</h1>
          <p className="cc-lede">
            Assign scouters, import the match schedule from The Blue Alliance, and jump into the
            scout workspace.
          </p>
        </div>
        <button
          className="cc-btn-primary"
          onClick={() => {
            performFullRefresh().catch(() => {});
            fetchServerScouters().catch(() => {});
          }}
        >
          Refresh
        </button>
      </div>

      <div className="cc-tiles">
        <button className="cc-tile blue" onClick={() => setView('scouters')}>
          <span className="cc-tile-mark">◈</span>
          <span className="cc-tile-fill" />
          <span className="cc-tile-title">ASSIGN SCOUTERS</span>
          <span className="cc-tile-sub">Manage scouter assignments for matches</span>
        </button>

        <button className="cc-tile teal" onClick={() => setView('matches')}>
          <span className="cc-tile-mark">▦</span>
          <span className="cc-tile-fill" />
          <span className="cc-tile-title">SELECT MATCHES</span>
          <span className="cc-tile-sub">Import matches from The Blue Alliance</span>
        </button>

        <button className="cc-tile black" onClick={() => setView('picklist')}>
          <span className="cc-tile-mark cyan">≣</span>
          <span className="cc-tile-fill" />
          <span className="cc-tile-title">SCOUT WORKSPACE</span>
          <span className="cc-tile-sub">
            Field ranking, picklist, analysis, strategy and forecast
          </span>
        </button>
      </div>
    </section>
  );
}
