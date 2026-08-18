import { ClimbByMatch, TbaMatchScores } from '../types';

const TBA_BASE_URL = 'https://www.thebluealliance.com/api/v3';
// Read API key from Vite env (build-time) but allow runtime override from localStorage
const BUILD_TBA_API_KEY = (import.meta as any).env?.VITE_TBA_API_KEY || '';
const RUNTIME_TBA_KEY_STORAGE = 'frc-tba-key';

export function getRuntimeTbaKey(): string | null {
  try {
    return localStorage.getItem(RUNTIME_TBA_KEY_STORAGE);
  } catch (e) {
    return null;
  }
}

export function setRuntimeTbaKey(key: string) {
  try {
    localStorage.setItem(RUNTIME_TBA_KEY_STORAGE, key);
  } catch (e) {
    // ignore
  }
}

export function clearRuntimeTbaKey() {
  try { localStorage.removeItem(RUNTIME_TBA_KEY_STORAGE); } catch (e) {}
}

function effectiveTbaKey(): string {
  return getRuntimeTbaKey() || BUILD_TBA_API_KEY || '';
}

// NOTE: default to 2026 while new-season events aren't published yet
export async function fetchEvents(year: number = 2026) {
  try {
    const key = effectiveTbaKey();
    // use the /simple endpoint to reduce payload
    const response = await fetch(`${TBA_BASE_URL}/events/${year}/simple`, {
      headers: key ? { 'X-TBA-Auth-Key': key } : {},
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('TBA fetchEvents failed', response.status, text);
      throw new Error('Failed to fetch events');
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching events:', error);
    return [];
  }
}

/**
 * Official qualification rankings for an event.
 *
 * Used to seed the picklist's eight alliance captains from real standings.
 * Returns an ordered list of team numbers (rank 1 first), or an empty array
 * when no TBA key is set or rankings aren't published yet — callers fall back
 * to ranking by our own scouting data.
 */
export async function fetchEventRankings(eventKey: string): Promise<number[]> {
  try {
    const key = effectiveTbaKey();
    if (!key) return [];
    const response = await fetch(`${TBA_BASE_URL}/event/${eventKey}/rankings`, {
      headers: { 'X-TBA-Auth-Key': key },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('TBA fetchEventRankings failed', response.status, text);
      return [];
    }

    const data = await response.json();
    const rankings: any[] = data?.rankings || [];
    return rankings
      .slice()
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      .map((r) => Number(String(r.team_key || '').replace(/^frc/, '')))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch (error) {
    console.error('Error fetching rankings:', error);
    return [];
  }
}

/** 2026 REBUILT tower point values by level — see the game manual §Scoring. */
const AUTO_TOWER_POINTS: Record<string, number> = { Level1: 15 };
const ENDGAME_TOWER_POINTS: Record<string, number> = { Level1: 10, Level2: 20, Level3: 30 };

/**
 * Credit every occupied tower slot in one alliance's one-phase breakdown.
 *
 * A slot is occupied when TBA's `{prefix}Robot{1,2,3}` field is a level
 * string rather than `"None"`; occupancy is positional against that
 * alliance's `team_keys`. Known levels use their fixed point value; an
 * unrecognised level (a future rule change) falls back to splitting the
 * alliance's reported phase total evenly across however many robots
 * occupied a slot, so a scoring change can never silently zero this out.
 */
function creditTowerSlots(
  sb: Record<string, unknown>,
  fieldPrefix: 'autoTowerRobot' | 'endGameTowerRobot',
  teamKeys: string[],
  pointsByLevel: Record<string, number>,
  allianceTotal: number | undefined,
  perTeam: Record<string, { auto: number; endgame: number }>,
  phase: 'auto' | 'endgame'
) {
  const occupied: Array<{ tk: string; level: string }> = [];
  for (let i = 1; i <= 3; i++) {
    const level = sb[`${fieldPrefix}${i}`];
    if (typeof level === 'string' && level !== 'None') {
      const tk = teamKeys[i - 1];
      if (tk) occupied.push({ tk, level });
    }
  }
  if (!occupied.length) return;

  const fallbackShare = (allianceTotal || 0) / occupied.length;
  for (const { tk, level } of occupied) {
    perTeam[tk][phase] += pointsByLevel[level] ?? fallbackShare;
  }
}

/**
 * Everything the app imports from TBA's published qualification results:
 * per-robot climb credit, and each alliance's fuel-only score.
 *
 * Both come from one `score_breakdown` fetch because they are read off the
 * same object, and both are ground truth rather than scouted estimates —
 * TBA names which robot occupied each tower slot, and publishes the exact
 * point split.
 *
 * `/matches` rather than `/matches/simple`: the simple variant omits
 * `score_breakdown` entirely, which is the only thing this needs.
 */
export async function fetchEventTbaScores(eventKey: string): Promise<TbaMatchScores> {
  const empty: TbaMatchScores = { climbByMatch: {}, fuelByAlliance: {} };
  try {
    const key = effectiveTbaKey();
    if (!key) return empty;
    const response = await fetch(`${TBA_BASE_URL}/event/${eventKey}/matches`, {
      headers: { 'X-TBA-Auth-Key': key },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('TBA fetchEventTbaScores failed', response.status, text);
      return empty;
    }

    const matches: any[] = await response.json();
    const climbByMatch: ClimbByMatch = {};
    const fuelByAlliance: Record<string, number> = {};

    for (const m of matches) {
      if ((m.comp_level ?? 'qm') !== 'qm') continue;
      const breakdown = m.score_breakdown;
      if (!breakdown) continue;

      const perTeam: Record<string, { auto: number; endgame: number }> = {};
      for (const alliance of ['red', 'blue'] as const) {
        const teamKeys: string[] = m.alliances?.[alliance]?.team_keys || [];
        const sb = breakdown[alliance];
        if (!sb || !teamKeys.length) continue;

        teamKeys.forEach((tk) => {
          if (tk) perTeam[tk] = perTeam[tk] || { auto: 0, endgame: 0 };
        });
        creditTowerSlots(sb, 'autoTowerRobot', teamKeys, AUTO_TOWER_POINTS, sb.autoTowerPoints, perTeam, 'auto');
        creditTowerSlots(sb, 'endGameTowerRobot', teamKeys, ENDGAME_TOWER_POINTS, sb.endGameTowerPoints, perTeam, 'endgame');

        // Fuel only — hubScore excludes tower, fouls and adjustments by
        // construction. Prefer its own total; fall back to summing the auto
        // and teleop halves if a future breakdown drops the total field.
        const hub = sb.hubScore;
        if (hub) {
          const fuel =
            typeof hub.totalPoints === 'number'
              ? hub.totalPoints
              : (hub.autoPoints ?? 0) + (hub.teleopPoints ?? 0);
          if (Number.isFinite(fuel) && fuel > 0) fuelByAlliance[`${m.key}|${alliance}`] = fuel;
        }
      }

      if (Object.keys(perTeam).length) climbByMatch[m.key] = perTeam;
    }

    return { climbByMatch, fuelByAlliance };
  } catch (error) {
    console.error('Error fetching TBA match scores:', error);
    return empty;
  }
}

export async function fetchEventMatches(eventKey: string) {
  try {
    const key = effectiveTbaKey();
    // use the /matches/simple endpoint to get compact match objects
    const response = await fetch(`${TBA_BASE_URL}/event/${eventKey}/matches/simple`, {
      headers: key ? { 'X-TBA-Auth-Key': key } : {},
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('TBA fetchEventMatches failed', response.status, text);
      throw new Error('Failed to fetch matches');
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching matches:', error);
    return [];
  }
}
/**
 * A robot photo for one team, newest season first.
 *
 * Cached in localStorage because TBA media is one request per team per year
 * and the picklist renders a card for every robot at the event — without the
 * cache, every visit to the tab would fire dozens of requests for images that
 * do not change during a competition. A miss is cached too (as an empty
 * string), so a team with no photo is not re-queried on every render.
 */
const PHOTO_CACHE_KEY = 'frc-team-photos';

function photoCache(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PHOTO_CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function cachePhoto(team: number, url: string) {
  try {
    const all = photoCache();
    all[String(team)] = url;
    localStorage.setItem(PHOTO_CACHE_KEY, JSON.stringify(all));
  } catch {
    // storage full — the photo simply gets fetched again next time
  }
}

function pickMediaUrl(media: any[]): string {
  for (const m of media || []) {
    if (m?.direct_url && /\.(jpg|jpeg|png|webp)$/i.test(m.direct_url)) return m.direct_url;
    if (m?.type === 'cdphotothread' && m?.details?.image_partial) {
      return (
        'https://www.thebluealliance.com/cdphotothread/img/' +
        String(m.details.image_partial).replace('_l.jpg', '_m.jpg')
      );
    }
  }
  return '';
}

export async function fetchTeamPhoto(team: number, years = [2026, 2025, 2024]): Promise<string> {
  const cached = photoCache()[String(team)];
  if (cached !== undefined) return cached;

  const key = effectiveTbaKey();
  if (!key) return '';

  for (const year of years) {
    try {
      const res = await fetch(`${TBA_BASE_URL}/team/frc${team}/media/${year}`, {
        headers: { 'X-TBA-Auth-Key': key },
      });
      if (!res.ok) continue;
      const url = pickMediaUrl(await res.json());
      if (url) {
        cachePhoto(team, url);
        return url;
      }
    } catch (e) {
      // Offline or blocked: leave it uncached so a later visit can retry.
      return '';
    }
  }
  cachePhoto(team, '');
  return '';
}
