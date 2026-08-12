import { useEffect, useMemo, useState } from 'react';
import { CvMatchLog, ScoutingData, TimelineScoutingData } from '../../types';
import { DataService } from '../../services/dataService';
import { loadScoutingRows } from '../../services/scoutingRows';
import { fetchEventRankings } from '../../services/tbaApi';
import {
  fetchCvLogs,
  fetchTimelines,
  getCvLogs,
  getTimelines,
} from '../../services/bpsStore';
import { BpsReport, runBpsPipeline } from '../../services/bps';
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
 * disagree with each other. The BPS solve lives here for the same reason, and
 * additionally because it is O(teams²): it must run once per data load, not
 * once per render and certainly not once per tab.
 */
export function useScoutData() {
  const [rows, setRows] = useState<ScoutingData[]>([]);
  const [timelines, setTimelines] = useState<TimelineScoutingData[]>([]);
  const [cvLogs, setCvLogs] = useState<CvMatchLog[]>([]);
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

      // The BPS streams are best-effort: a server that is down or a schema
      // that predates these tables must not take the legacy screens with it,
      // so each falls back to the local copy exactly as scouting rows do.
      const [tl, cv] = await Promise.all([
        fetchTimelines().catch(() => getTimelines()),
        fetchCvLogs().catch(() => getCvLogs()),
      ]);

      if (!mounted) return;
      // The server holds timelines/CV logs for every event any device has
      // ever scouted — same shape as the `matches` table, and the same fix
      // applies: scope to the selected event here, at the one place both
      // streams enter the workspace. Unscoped, another event's leftover data
      // (a stray test run, last month's regional) silently blends into this
      // event's solve — every team's rate shifts, and the solver's "how many
      // matches have I actually got" bookkeeping undercounts the pollution
      // as real evidence.
      const selectedEvent = DataService.getSelectedEvent();
      const inSelectedEvent = (matchKey: string) =>
        !selectedEvent || DataService.matchBelongsToEvent({ key: matchKey }, selectedEvent);
      setRows(loaded);
      setTimelines(tl.filter((t) => inSelectedEvent(t.matchKey)));
      setCvLogs(cv.filter((c) => inSelectedEvent(c.matchKey)));
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

  /**
   * The single BPS solve for the whole workspace. Null until there is
   * something to solve, which keeps the legacy-only case entirely off this
   * code path.
   */
  const bpsReport = useMemo<BpsReport | null>(() => {
    if (!timelines.length || !cvLogs.length) return null;
    try {
      return runBpsPipeline(timelines, cvLogs);
    } catch (e) {
      console.error('useScoutData: BPS solve failed, falling back to legacy', e);
      return null;
    }
  }, [timelines, cvLogs]);

  const metrics = useMemo(
    // By request: the workspace shows ONLY BPS (timeline + CV scoreboard)
    // data now, not the legacy fuel-count form. Passing no legacy rows means
    // buildTeamMetrics has nothing to fall back to, so a team with no fused
    // BPS match is "unscouted" rather than showing old-form or CSV-imported
    // season stats. `rows` itself is untouched and still returned from this
    // hook — CSV export/backup (StatsImportControl) still needs the real
    // scouting_records — only the metrics/ranking build stops reading it.
    () => buildAllTeamMetrics([], teamKeys, matches, timelines, bpsReport),
    [teamKeys, matches, timelines, bpsReport]
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

  /**
   * True when at least one team on the field has solved BPS numbers. Screens
   * gate their BPS columns on this so a legacy-only event looks untouched.
   */
  const hasBps = useMemo(() => metrics.some((m) => m.hasBps), [metrics]);

  const scoutedCount = useMemo(() => metrics.filter((m) => m.hasData).length, [metrics]);

  return {
    rows,
    timelines,
    cvLogs,
    bpsReport,
    hasBps,
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
