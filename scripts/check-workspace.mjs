// Vite's installed esbuild compiles the real app modules for these Node checks.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const dir = mkdtempSync(join(tmpdir(), 'scout-workspace-'));
try {
  const out = join(dir, 'checks.cjs');
  await build({entryPoints:['scripts/workspace-cases.ts'],outfile:out,bundle:true,platform:'node',format:'cjs'});
  createRequire(import.meta.url)(out);
} finally { rmSync(dir,{recursive:true,force:true}); }
