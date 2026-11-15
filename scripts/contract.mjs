import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const [binary = "dist/ambitious-tasks.mjs", ...extra] = process.argv.slice(2);
if (extra.length > 0 || binary.startsWith("--")) throw new Error("Usage: node scripts/contract.mjs [built-module]");
const fixtures = {
  get: { id: "contract-task" },
  history: { id: "contract-task" },
  "process simulate": { scenarios: [{ name: "baseline" }], runs: 1 },
  "schedule suggest": { people: [], horizon_days: 7 },
  "schedule check": { assignments: [], people: [] },
};
const sourcePath = fileURLToPath(import.meta.resolve("@ambitious/kit/contract/checks"));
const source = readFileSync(sourcePath, "utf8");
const inputLine = 'const stdin = input ? "{}" : "";';
if (source.split(inputLine).length !== 2) throw new Error("The shared read-only probe changed. Review the command input adapter before running it.");
const adapted = source.replace(inputLine, `const stdin = input ? JSON.stringify(${JSON.stringify(fixtures)}[name] ?? {}) : "";`);
const output = resolve(".build/contract-checks.mjs");
mkdirSync(dirname(output), { recursive: true });
await build({ stdin: { contents: adapted, resolveDir: dirname(sourcePath), sourcefile: "contract-checks.js" },
  bundle: true, format: "esm", platform: "node", outfile: output, logLevel: "silent" });
const { runContract } = await import(pathToFileURL(output).href);
const results = runContract(binary);
const width = Math.max(...results.map(({ id }) => id.length));
for (const { id, title, problems } of results) {
  process.stdout.write(`${problems.length === 0 ? "ok  " : "FAIL"}  ${id.padEnd(width)}  ${title}\n`);
  for (const problem of problems) process.stdout.write(`      ${problem}\n`);
}
const failed = results.filter(({ problems }) => problems.length > 0).length;
process.stdout.write(failed === 0
  ? `contract: ok. ${results.length} of ${results.length} checks passed for ${binary}.\n`
  : `contract: ${failed} of ${results.length} checks failed for ${binary}.\n`);
process.exitCode = failed === 0 ? 0 : 1;
