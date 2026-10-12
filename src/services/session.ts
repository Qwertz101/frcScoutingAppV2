import type { User } from '../types';

const COOKIE = 'frc-session-v1';

/** A remembered identity for convenience, matching the app's existing simple login. */
export function readSession(): User | null {
  try {
    const raw = document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
    if (!raw) return null;
    const u = JSON.parse(decodeURIComponent(raw.slice(COOKIE.length + 1)));
    if (typeof u.username !== 'string' || !u.username.trim() ||
      !['red', 'blue'].includes(u.alliance) || ![1, 2, 3].includes(u.position) ||
      typeof u.isAdmin !== 'boolean') return null;
    return { username: u.username, alliance: u.alliance, position: u.position, isAdmin: u.isAdmin };
  } catch { return null; }
}
export function saveSession(user: User): void {
  document.cookie = COOKIE + '=' + encodeURIComponent(JSON.stringify(user)) +
    '; Path=/; Max-Age=31536000; SameSite=Lax';
}
export function clearSession(): void {
  document.cookie = COOKIE + '=; Path=/; Max-Age=0; SameSite=Lax';
}
