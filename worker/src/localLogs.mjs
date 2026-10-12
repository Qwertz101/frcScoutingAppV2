import { mkdir, writeFile, rename, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WORKER_DIR } from './core.mjs';

/** Preserve derived observations even without Supabase or a match identity. */
export async function saveLocalLog(log, directory = join(WORKER_DIR, 'logs')) {
  await mkdir(directory, { recursive: true });
  const filename = String(log.eventKey || 'event').replace(/[^a-zA-Z0-9_-]/g, '_') + '-' + Date.now() + '-' + randomUUID() + '.json';
  const path = join(directory, filename);
  await writeFile(path + '.tmp', JSON.stringify(log, null, 2) + '\n', { mode: 0o600 });
  await rename(path + '.tmp', path);
  return path;
}

export async function listLocalLogs(eventKey, directory = join(WORKER_DIR, 'logs')) {
  const names = await readdir(directory).catch(() => []);
  const rows = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort().reverse().slice(0, 100)) {
    try {
      const log = JSON.parse(await readFile(join(directory, name), 'utf8'));
      if (eventKey && log.eventKey !== eventKey) continue;
      const last = log.samples?.at(-1);
      rows.push({ match_key: log.matchKey || '', event_key: log.eventKey, source: log.source,
        quality: log.quality, flagged: Boolean(log.flagged),
        final: last ? { blue: last.blue, red: last.red } : null,
        local_file: name, greenFlagAt: log.video?.greenFlagAt,
        updated_at: new Date(log.createdAt).toISOString() });
    } catch { /* An interrupted or invalid file must not prevent startup. */ }
  }
  return rows;
}
