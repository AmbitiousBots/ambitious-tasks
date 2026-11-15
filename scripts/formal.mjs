import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

mkdirSync('.build/formal', { recursive: true });
cpSync('spec', '.build/formal', { recursive: true });
const expected = JSON.parse(readFileSync('spec/broken/EXPECTED.json', 'utf8'));
writeFileSync('.build/formal/broken/EXPECTED.json', JSON.stringify(Object.fromEntries(
  Object.entries(expected).map(([name, invariant]) => [name, { invariant, because: 'Removing this protection must violate its named invariant.' }]),
)));
const result = spawnSync(process.execPath, ['scripts/tlc.mjs', '.build/formal'], { stdio: 'inherit' });
process.exitCode = result.status ?? 2;
