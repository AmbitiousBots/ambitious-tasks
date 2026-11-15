import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import './build.mjs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const name = `ambitious-tasks-${version}.mjs`;
mkdirSync('release', { recursive: true });
copyFileSync('dist/ambitious-tasks.mjs', `release/${name}`);
chmodSync(`release/${name}`, 0o755);
const checksum = createHash('sha256').update(readFileSync(`release/${name}`)).digest('hex');
writeFileSync('release/SHA256SUMS', `${checksum}  ${name}\n`);
process.stdout.write(`${checksum}  ${name}\n`);
