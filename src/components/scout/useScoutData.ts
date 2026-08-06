import { useEffect, useMemo, useState } from 'react';
import { ScoutingData } from '../../types';
import { DataService } from '../../services/dataService';
import { loadScoutingRows } from '../../services/scoutingRows';
import { fetchEventRankings } from '../../services/tbaApi';
import {
  buildAllTeamMetrics,
  teamsFromMatches,
  percentile,
  TeamMetrics,
} from '../../utils/teamMetrics';

/**
 * Loads scouting data once for the whole Scout shell.
 *
 * Every tab reads from this single result — tabs must not fetch their own data,
 * otherwise switching tabs would re-hit the network and the screens could
 * disagree with each other.
 */
export function useScoutData() {
  const [rows, setRows] = useState<ScoutingData[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [rankings, setRankings] = useState<number[]>([]);
  const [reloadToken, setReloadToken] = useState(0);

  const matches = useMemo(
    () => (DataService.getMatches() || []).filter((m: any) => !m.deletedAt),
    [reloadToken]
  );
  const eventKey = DataService.getSelectedEvent();

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    (async () => {
      const { rows: loaded, error } = await loadScoutingRows();
      if (!mounted) return;
      setRows(loaded);
      setDataError(error);
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [reloadToken]);

  useEffect(() => {
    if (!eventKey) return;
    let mounted = true;
    fetchEventRankings(eventKey).then((r) => mounted && setRankings(r));
    return () => {
      mounted = false;
    };
  }, [eventKey]);

  const teamKeys = useMemo(() => {
    const fromMatches = teamsFromMatches(matches);
    if (fromMatches.length) return fromMatches;
    return Array.from(new Set(rows.map((r) => r.teamKey))).sort();
  }, [matches, rows]);

  const metrics = useMemo(
    () => buildAllTeamMetrics(rows, teamKeys, matches),
    [rows, teamKeys, matches]
  );

  const metricsByTeam = useMemo(() => {
    const map = new Map<number, TeamMetrics>();
    metrics.forEach((m) => map.set(m.teamNumber, m));
    return map;
  }, [metrics]);

  /** Median scoring across teams we have data for — the yardstick for tags. */
  const fieldMedian = useMemo(() => {
    const scored = metrics.filter((m) => m.hasData).map((m) => m.adjMean);
    return scored.length ? percentile(scored, 0.5) : 1;
  }, [metrics]);

  /** Ranking order: official standings when available, else our own scouting. */
  const rankedTeams = useMemo(() => {
    const known = new Set(metrics.map((m) => m.teamNumber));
    if (rankings.length) {
      const inField = rankings.filter((t) => known.has(t));
      const rest = metrics
        .filter((m) => !rankings.includes(m.teamNumber))
        .sort((a, b) => b.adjMean - a.adjMean)
        .map((m) => m.teamNumber);
      return [...inField, ...rest];
    }
    return [...metrics].sort((a, b) => b.adjMean - a.adjMean).map((m) => m.teamNumber);
  }, [metrics, rankings]);

  /** True when at least one team's numbers came from the stats-CSV importer. */
  const hasSynthetic = useMemo(() => metrics.some((m) => m.isSynthetic), [metrics]);

  const scoutedCount = useMemo(() => metrics.filter((m) => m.hasData).length, [metrics]);

  return {
    rows,
    loading,
    dataError,
    matches,
    eventKey,
    teamKeys,
    metrics,
    metricsByTeam,
    metricsFor: (team: number) => metricsByTeam.get(team),
    fieldMedian,
    rankedTeams,
    hasSynthetic,
    scoutedCount,
    usingOfficialRankings: rankings.length > 0,
    reload: () => setReloadToken((t) => t + 1),
  };
}

export type ScoutData = ReturnType<typeof useScoutData>;
