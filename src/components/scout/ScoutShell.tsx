import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useScoutData } from './useScoutData';
import { usePicklistState } from './usePicklistState';
import { FieldRanking } from './FieldRanking';
import { MatchStrategy } from './MatchStrategy';
import { RankForecast } from './RankForecast';
import { Picklist } from '../picklist/Picklist';
import { AllianceSelection } from '../picklist/AllianceSelection';
import { TeamDeepDive } from './TeamDeepDive';
import { StatsImportControl } from './StatsImportControl';
import '../picklist/picklist.css';
// Modal/banner classes for the import dialog, which the picklist sheet has no
// equivalent for.
import '../../styles/cc.css';

type Tab = 'rank' | 'pick' | 'alliance' | 'strat' | 'predict';

const TABS: { key: Tab; label: string }[] = [
  { key: 'rank', label: 'Field Ranking' },
  { key: 'pick', label: 'Picklist' },
  { key: 'alliance', label: 'Alliance Selection' },
  { key: 'strat', label: 'Match Strategy' },
  { key: 'predict', label: 'Rank Forecast' },
];

const BoltMark = () => (
  <svg className="pl-bolt" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="pl-bolt-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#00baff" />
        <stop offset="100%" stopColor="#1179ee" />
      </linearGradient>
    </defs>
    <path d="M13.5 2 4 13.5h6L9.5 22 20 10h-6.5z" fill="url(#pl-bolt-grad)" />
  </svg>
);

interface ScoutShellProps {
  onBack: () => void;
}

/**
 * The five-tab Scout workspace.
 *
 * Data and alliance-selection state are loaded here once and passed down, so
 * switching tabs never refetches and every screen agrees on the same numbers.
 */
export function ScoutShell({ onBack }: ScoutShellProps) {
  const [tab, setTab] = useState<Tab>('rank');
  const [dark, setDark] = useState(false);
  const [focusTeam, setFocusTeam] = useState<number | null>(null);

  const data = useScoutData();
  const pick = usePicklistState(data.rankedTeams, !data.loading);

  /**
   * Jump straight to a robot's deep dive from any screen.
   *
   * The deep dive is an overlay over whichever tab is open rather than a tab
   * of its own — there is no longer a Team Analysis tab to land on, and
   * closing it should put the user back where they were mid-task instead of
   * on a screen they never chose.
   */
  const openTeam = (team: number) => setFocusTeam(team);

  return (
    <div className={`picklist-root${dark ? ' dark' : ''}`}>
      <header className="pl-header">
        <div className="pl-brand">
          <BoltMark />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="pl-brand-name">SCOUT {pick.ourTeam}</span>
            <span className="pl-brand-sub">
              Rebuilt · {data.eventKey ? data.eventKey.toUpperCase() : 'no event selected'}
            </span>
          </div>
        </div>

        <nav className="pl-nav">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`pl-nav-btn${tab === t.key ? ' active' : ''}`}
              onClick={() => {
                setTab(t.key);
                setFocusTeam(null);
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="pl-header-spacer" />

        <div className="pl-header-right">
          <span className="pl-live">
            <span className="pl-live-dot" />
            {data.teamKeys.length} teams · {data.scoutedCount} scouted · {data.matches.length} matches
          </span>
          <label className="pl-live" style={{ gap: 6 }}>
            our team
            <input
              className="pl-team-input"
              type="number"
              value={pick.ourTeam}
              onChange={(e) => pick.setOurTeam(Number(e.target.value) || 0)}
            />
          </label>
          <StatsImportControl onImported={data.reload} rows={data.rows} />
          <button className={`pl-ghost-btn${dark ? ' active' : ''}`} onClick={() => setDark(!dark)}>
            {dark ? 'Light mode' : 'Dark mode'}
          </button>
          <button className="pl-ghost-btn" onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ArrowLeft className="w-4 h-4" />
            Admin
          </button>
        </div>
      </header>

      {data.loading && <div className="pl-body"><div className="pl-empty">Loading scouting data…</div></div>}

      {!data.loading && data.teamKeys.length === 0 && (
        <div className="pl-body">
          <div className="pl-card">
            <div className="pl-empty">
              No teams found. Import an event under <strong>Select Matches</strong> first — every
              screen builds its field from the match schedule.
            </div>
          </div>
        </div>
      )}

      {!data.loading && data.teamKeys.length > 0 && (
        <>
          {data.dataError && (
            <div className="pl-body" style={{ paddingBottom: 0 }}>
              <div className="pl-card">
                <div className="pl-empty">
                  Showing locally cached scouting data — the server was unreachable ({data.dataError}).
                </div>
              </div>
            </div>
          )}

          {focusTeam != null && data.metricsFor(focusTeam) ? (
            <TeamDeepDive
              team={data.metricsFor(focusTeam)!}
              data={data}
              pick={pick}
              onBack={() => setFocusTeam(null)}
              onFocusTeam={setFocusTeam}
            />
          ) : (
            <>
              {tab === 'rank' && <FieldRanking data={data} pick={pick} onOpenTeam={openTeam} />}
              {tab === 'pick' && <Picklist data={data} pick={pick} />}
              {tab === 'alliance' && <AllianceSelection data={data} pick={pick} />}
              {tab === 'strat' && <MatchStrategy data={data} pick={pick} onOpenTeam={openTeam} />}
              {tab === 'predict' && <RankForecast data={data} pick={pick} onOpenTeam={openTeam} />}
            </>
          )}
        </>
      )}
    </div>
  );
}
