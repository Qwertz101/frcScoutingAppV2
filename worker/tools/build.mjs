/**
 * Compile the shared CV core into `worker/gen` as CommonJS.
 *
 * The stamped `package.json` is load-bearing: the repo root is
 * `"type": "module"`, so without it Node reads these emitted `.js` files as
 * ESM and every internal `require` inside them fails.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const workerDir = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(workerDir);

// Invoke tsc's JS entry point with this same Node binary rather than the
// `npx`/`tsc` shim: spawning a `.cmd` without a shell is EINVAL on modern Node
// for Windows, and going through a shell would need quoting we do not want.
execFileSync(
  process.execPath,
  [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(workerDir, 'tsconfig.worker.json')],
  { cwd: root, stdio: 'inherit' }
);
writeFileSync(join(workerDir, 'gen/package.json'), '{"type":"commonjs"}\n');
console.log('worker/gen built');
