import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './core.mjs';

export const DEFAULT_CONFIG_PATH = resolve(REPO_ROOT, 'config/server.local.json');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Load the optional, gitignored server configuration without exposing secrets. */
export function loadServerConfig(path = DEFAULT_CONFIG_PATH) {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) return { path: fullPath, exists: false, value: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (error) {
    throw new Error('could not read server config ' + fullPath + ': ' + error.message);
  }
  if (!isObject(parsed)) throw new Error('server config must contain a JSON object');
  return { path: fullPath, exists: true, value: parsed };
}

const ENV_PATHS = {
  SUPABASE_URL: ['supabase', 'url'],
  SUPABASE_ANON_KEY: ['supabase', 'publishableKey'],
  TBA_API_KEY: ['tba', 'apiKey'],
  OCR_WORKERS: ['capture', 'ocrWorkers'],
  FFMPEG_PATH: ['tools', 'ffmpegPath'],
  FFPROBE_PATH: ['tools', 'ffprobePath'],
  YT_DLP_PATH: ['tools', 'ytDlpPath'],
};

/** Read an environment-style setting from the local JSON config. */
export function readServerConfigValue(name, path = process.env.SCOUT_SERVER_CONFIG || DEFAULT_CONFIG_PATH) {
  const keys = ENV_PATHS[name];
  if (!keys) return null;
  const { value } = loadServerConfig(path);
  let current = value;
  for (const key of keys) {
    if (!isObject(current) || !(key in current)) return null;
    current = current[key];
  }
  if (current === null || current === undefined || current === '') return null;
  return String(current);
}
