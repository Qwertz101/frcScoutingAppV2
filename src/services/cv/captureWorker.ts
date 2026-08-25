/**
 * Talking to the capture worker running on this machine.
 *
 * The browser cannot read a YouTube or Twitch page pixel-by-pixel — that is a
 * hard cross-origin rule, not a setting — so the CV tab's link box does not try.
 * It hands the link to `worker/src/server.mjs`, which has ffmpeg and yt-dlp and
 * no such restriction, and then watches what comes back.
 *
 * The worker is loopback-only (see `worker/src/dashboard.mjs`), so this only
 * works when the app is open on the same machine the worker runs on — which is
 * exactly the workshop-PC arrangement it is for. Everywhere else it simply
 * reports itself as unreachable and the manual Upload/Share Screen paths carry
 * on working as they always have.
 */

/** The port the worker listens on. Matches DASHBOARD_PORT in worker/src/dashboard.mjs. */
const WORKER_PORT = '7654';

/**
 * Where to reach the worker.
 *
 * Empty (i.e. relative) when this page is *already* served by the worker, which
 * is the arrangement that actually works end to end. The deployed copy at
 * `https://qwertz101.github.io` cannot reach a machine-local address at all --
 * the browser blocks it before CORS is consulted, and neither an origin
 * allow-list nor Chrome's Private Network Access opt-in lifts it. Serving the
 * app from the worker (`http://127.0.0.1:7654/app`) removes the cross-origin
 * hop entirely rather than trying to negotiate it.
 *
 * The absolute fallback still covers `npm run dev`, where the app is on Vite's
 * port and the worker is on its own; both are loopback, so that hop is allowed.
 */
export const WORKER_BASE =
  typeof window !== 'undefined' && window.location.port === WORKER_PORT
    ? ''
    : `http://127.0.0.1:${WORKER_PORT}`;

/** Where the operator can open the worker's own dashboard. */
export const WORKER_DASHBOARD_URL = `http://127.0.0.1:${WORKER_PORT}`;

export type JobMode = 'vod' | 'live';
export type JobStatus = 'running' | 'cancelling' | 'done' | 'cancelled' | 'error';

export interface WorkerJob {
  id: string;
  url: string;
  mode: JobMode;
  eventKey: string;
  write: boolean;
  download: boolean;
  layout: string | null;
  status: JobStatus;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  lastLine: string;
  /** `at`/`from`/`to` are seconds into the recording; `to - from` is the work asked for. */
  progress: { phase: string; at: number; from: number; to: number; total: number } | null;
  matches: number;
}

export interface WorkerRow {
  match_key: string;
  event_key: string;
  source: string;
  quality?: { score: number; reasons: string[]; flagged?: boolean } | null;
  flagged?: boolean;
  final: { blue: number; red: number } | null;
  greenFlagAt?: number;
  write?: string;
}

export interface WorkerState {
  eventKey: string;
  at: number;
  unmigrated: boolean;
  unidentified: number;
  /** False when the worker was started without `--write`, so every job is dry. */
  allowWrite: boolean;
  source: { label: string; status: string };
  job: WorkerJob | null;
  logLines: string[];
  rows: WorkerRow[];
}

export interface SubmitJobRequest {
  url: string;
  eventKey?: string;
  mode?: JobMode;
  /** Pass false for a dry run. Cannot enable writing the worker was not started with. */
  write?: boolean;
  start?: number;
  duration?: number;
  /**
   * Fetch the footage to a temp file first, then read it locally.
   *
   * Much faster than reading a remote VOD, where every seek is a network round
   * trip. The file is deleted as soon as the job finishes.
   */
  download?: boolean;
}

/**
 * A failed call carries the worker's own message wherever it gave one.
 *
 * The refusals this endpoint produces are nearly all things the operator needs
 * to read verbatim — "a capture is already running", "that event is not on
 * TBA" — so collapsing them into a generic failure would throw away the only
 * useful part.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(WORKER_BASE + path, init);
  } catch {
    throw new Error(
      WORKER_BASE
        ? 'Cannot reach the capture worker. Start it with "npm run worker:serve" — ' +
          'and note that a browser will not let this page reach a local worker unless ' +
          'the page itself is local. Open http://127.0.0.1:7654/app instead of the ' +
          'published site.'
        : 'The capture worker stopped responding. Check the terminal it is running in.'
    );
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `worker returned ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

/** Is the worker up, and can it start captures? */
export async function pingWorker(): Promise<{ ok: boolean; jobs: boolean }> {
  try {
    return await call<{ ok: boolean; jobs: boolean }>('/api/ping');
  } catch {
    return { ok: false, jobs: false };
  }
}

export function getWorkerState(): Promise<WorkerState> {
  return call<WorkerState>('/api/state');
}

export function submitJob(req: SubmitJobRequest): Promise<WorkerJob> {
  return call<WorkerJob>('/api/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

export function cancelJob(): Promise<WorkerJob> {
  return call<WorkerJob>('/api/job/cancel', { method: 'POST' });
}

export function reprocessMatch(matchKey: string, greenFlagAt?: number) {
  return call<{ ok: boolean }>('/api/reprocess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matchKey, greenFlagAt }),
  });
}

