import { spawnSync } from 'node:child_process';

const cache = spawnSync('lake', ['exe', 'cache', 'get'], { cwd: 'proofs', stdio: 'inherit' });
if (cache.error) {
  process.stderr.write('Lean requires elan and the toolchain pinned in proofs/lean-toolchain. Install elan, then rerun npm run lean.\n');
  process.exit(2);
}
if (cache.status !== 0) process.stderr.write('The optional Mathlib cache could not be downloaded; lake build will compile the dependencies.\n');
const result = spawnSync('lake', ['build'], { cwd: 'proofs', stdio: 'inherit' });
process.exitCode = result.status ?? 2;
