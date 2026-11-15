import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync('.build/tmp', { recursive: true });
const steps = ['typecheck', 'lint', 'depcruise', 'test', 'contract', 'tlc', 'lean', 'verify', 'release:build'];
for (const step of steps) {
  process.stdout.write(`\n=== npm run ${step}\n`);
  const result = spawnSync('npm', ['run', step], { stdio: 'inherit', env: { ...process.env, TMPDIR: resolve('.build/tmp') } });
  if (result.status !== 0) process.exit(result.status ?? 2);
}
process.stdout.write(`\nrelease check: ok. ${steps.length} of ${steps.length} steps passed.\n`);
