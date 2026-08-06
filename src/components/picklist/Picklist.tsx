import { useMemo } from 'react';
import { TeamMetrics, projectAlliance } from '../../utils/teamMetrics';
import { ScoutData } from '../scout/useScoutData';
import { PicklistState } from '../scout/usePicklistState';
import { SyntheticFootnote } from '../scout/FieldRanking';
import { AllianceBoard } from './AllianceBoard';
import { OurAlliance } from './OurAlliance';
import { OfferAdvisor } from './OfferAdvisor';
import { DnpList } from './DnpList';
import { TierList } from './TierList';
import { ProjectedAlliance } from './ProjectedAlliance';
import { PicklistTree } from './PicklistTree';
import './picklist.css';

interface PicklistProps {
  data: ScoutData;
  pick: PicklistState;
}

/**
 * Alliance-selection board. Rendered as a tab inside ScoutShell, which owns the
 * data loading and the shared picklist state.
 */
export function Picklist({ data, pick }: PicklistProps) {
  const { metricsFor, fieldMedian, hasSynthetic } = data;
  const {
    ourTeam, tier1, tier2, dnp, board, branches,
    setTier1, setTier2, setDnp, setBranches,
    takenTeams, pool, onTheClock, addToClock, removePick, resetBoard,
    restoreDnp, tierHandlers,
  } = pick;

  const t1 = tierHandlers(tier1, setTier1, tier2, setTier2);
  const t2 = tierHandlers(tier2, setTier2, tier1, setTier1);

  const scaleMax = useMemo(() => {
    const strengths = board.map((a) => {
      const members = [a.captain, ...a.picks]
        .filter((t): t is number => t != null)
        .map(metricsFor)
        .filter((m): m is TeamMetrics => !!m);
      return members.length ? projectAlliance(members).pts : 0;
    });
    return Math.max(100, Math.ceil((Math.max(...strengths, 0) * 1.25) / 10) * 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, metricsFor]);

  const setBranchSlot = (id: number, slot: 'cap' | 'second', team: number | null) =>
    setBranches(branches.map((b) => (b.id === id ? { ...b, [slot]: team } : b)));

  const addBranch = () =>
    setBranches([
      ...branches,
      { id: branches.reduce((m, b) => Math.max(m, b.id), 0) + 1, cap: null, second: null },
    ]);

  return (
    <div className="pl-body">
      <div className="pl-title-row">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 auto' }}>
          <span className="pl-eyebrow">Step 2 — picklist</span>
          <h1 className="pl-h1">PICKLIST</h1>
        </div>
        <p className="pl-lede">
          Log every alliance's pick on the board below. Reorder the 1st/2nd pick tier lists to match
          your priorities — the projected alliance and picklist tree update live as teams come off
          the board.
        </p>
        <button className="pl-pill-btn" onClick={resetBoard}>
          Reset board
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }}>
        <AllianceBoard
          board={board}
          metricsFor={metricsFor}
          ourTeam={ourTeam}
          onTheClock={onTheClock}
          pool={pool}
          fieldMedian={fieldMedian}
          onAddToClock={addToClock}
          onRemovePick={removePick}
        />

        <div className="pl-two-col">
          <OurAlliance board={board} metricsFor={metricsFor} ourTeam={ourTeam} />
          <OfferAdvisor board={board} metricsFor={metricsFor} ourTeam={ourTeam} />
        </div>
      </div>

      <div className="pl-columns">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <DnpList
            entries={dnp}
            onRestore={restoreDnp}
            onReasonChange={(team, reason) =>
              setDnp(dnp.map((d) => (d.team === team ? { ...d, reason } : d)))
            }
          />
        </div>

        <div className="pl-two-col">
          <TierList
            title="CAPTAINS · MIGHT PICK US"
            variant="tier1"
            teams={tier1}
            metricsFor={metricsFor}
            fieldMedian={fieldMedian}
            taken={takenTeams}
            moveLabel="→ 2nd"
            {...t1}
          />
          <TierList
            title="2ND PICK SHORTLIST"
            variant="tier2"
            teams={tier2}
            metricsFor={metricsFor}
            fieldMedian={fieldMedian}
            taken={takenTeams}
            moveLabel="→ 1st"
            {...t2}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <ProjectedAlliance
            board={board}
            metricsFor={metricsFor}
            ourTeam={ourTeam}
            scaleMax={scaleMax}
          />
        </div>
      </div>

      <PicklistTree
        branches={branches}
        board={board}
        metricsFor={metricsFor}
        ourTeam={ourTeam}
        onSetSlot={setBranchSlot}
        onAddBranch={addBranch}
        onRemoveBranch={(id) => setBranches(branches.filter((b) => b.id !== id))}
      />

      <p className="pl-note" style={{ marginTop: 14, maxWidth: 900 }}>
        Match points follow the 2026 <em>REBUILT</em> scoring table: fuel is 1 point in both AUTO and
        TELEOP, an AUTO tower climb is 15, and a TELEOP climb is 10 / 20 / 30 for levels 1–3.
      </p>

      {hasSynthetic && <SyntheticFootnote />}
    </div>
  );
}
