import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = mkdtempSync(join(tmpdir(), 'scout-fusion-'));
try {
  const out = join(dir, 'checks.cjs');
  await build({ entryPoints: ['scripts/fusion-cases.ts'], outfile: out, bundle: true,
    platform: 'node', format: 'cjs', plugins: [{ name: 'fake-cloud', setup(b) {
      b.onResolve({ filter: /supabaseClient$/ }, () => ({ path: resolve('scripts/fusion-fakes.ts') }));
    }}], logLevel: 'error' });
  const result = spawnSync(process.execPath, ['--test', out], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
