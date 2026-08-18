import { useEffect, useState } from 'react';
import { fetchTeamPhoto } from '../../services/tbaApi';

/**
 * Robot photos for a set of teams, keyed by team number.
 *
 * Fetched lazily and one team at a time (`fetchTeamPhoto` caches in
 * localStorage, so this is a no-op network-wise after the first visit).
 * Photos are decoration: a team with none simply renders its placeholder, and
 * a failed fetch never blocks the screen.
 */
export function useTeamPhotos(teams: number[]): Record<number, string> {
  const [photos, setPhotos] = useState<Record<number, string>>({});
  const key = teams.join(',');

  useEffect(() => {
    let mounted = true;
    const list = key ? key.split(',').map(Number) : [];
    (async () => {
      for (const team of list) {
        const url = await fetchTeamPhoto(team);
        if (!mounted) return;
        if (url) setPhotos((p) => (p[team] === url ? p : { ...p, [team]: url }));
      }
    })();
    return () => {
      mounted = false;
    };
  }, [key]);

  return photos;
}
