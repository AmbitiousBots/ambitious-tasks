#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tlaToolchain, ToolchainError } from "./tla2tools.mjs";

const EXPECTED_FILE = "EXPECTED.json";

const USAGE = `Usage: node scripts/tlc.mjs [spec-directory]

Runs TLC, the TLA+ model checker, on every model in the spec directory
(default: spec) and prints a table of what each model had to do and did.

  <spec>/X.cfg + X.tla           A model. TLC must find no error.
  <spec>/broken/Y.cfg + Y.tla    A model with one protection removed. TLC must
                                 find that it breaks the invariant listed for
                                 it in <spec>/broken/${EXPECTED_FILE}.

${EXPECTED_FILE} names, for every broken variant, the invariant it must break
and why:
  { "Y": { "invariant": "<name>", "because": "<plain sentence>" } }

A broken variant that passes, breaks a different invariant, or cannot be read
is a failure: it means the model does not catch the mistake it was written to
catch. A spec directory needs at least one model and one broken variant.

TLC and Java are pinned in .mise.toml; see node scripts/tla2tools.mjs --help.

Exit code 0: every model behaved as required. 1: at least one did not.
2: TLC could not be started.
`;

const TLC_EXIT_MEANING = new Map([
  [10, "an assumption in the model is false"],
  [11, "reached a state with no next step (deadlock)"],
  [13, "broke a temporal property"],
  [150, "could not be read: TLC reported errors in the model text"],
  [151, "could not be read: TLC reported errors in the configuration"],
]);

const modelNames = (directory) =>
  existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith(".cfg"))
        .map((name) => name.slice(0, -".cfg".length))
        .sort()
    : [];

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

const readExpected = (brokenDirectory) => {
  const path = join(brokenDirectory, EXPECTED_FILE);
  if (!existsSync(path)) return { entries: new Map(), problems: [] };
  const shape = `Give ${path} the shape { "<variant>": { "invariant": "<name>", "because": "<plain sentence>" } }.`;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { entries: new Map(), problems: [{ model: path, fix: `Make ${path} valid JSON: ${error.message}` }] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { entries: new Map(), problems: [{ model: path, fix: shape }] };
  }
  const valid = ([, entry]) => isNonEmptyString(entry?.invariant) && isNonEmptyString(entry?.because);
  const all = Object.entries(parsed);
  return {
    entries: new Map(all.filter(valid).map(([name, entry]) => [name, entry.invariant])),
    problems: all
      .filter((item) => !valid(item))
      .map(([name]) => ({ model: path, fix: `Entry "${name}" needs an "invariant" and a "because". ${shape}` })),
  };
};

const plan = (specDirectory) => {
  const brokenDirectory = join(specDirectory, "broken");
  const models = modelNames(specDirectory);
  const variants = modelNames(brokenDirectory);
  const expected = readExpected(brokenDirectory);
  const expectedPath = join(brokenDirectory, EXPECTED_FILE);
  const missingText = (directory, name) =>
    existsSync(join(directory, `${name}.tla`))
      ? []
      : [{ model: join(directory, name), fix: `Add ${join(directory, `${name}.tla`)}: every .cfg needs the model it configures.` }];
  const problems = [
    ...(models.length === 0
      ? [{ model: specDirectory, fix: `Add a model to ${specDirectory}: X.tla with X.cfg. There is nothing to check.` }]
      : []),
    ...(models.length > 0 && variants.length === 0
      ? [
          {
            model: brokenDirectory,
            fix: `Add a broken variant to ${brokenDirectory}: a copy of a model with one protection removed, and its entry in ${EXPECTED_FILE}. Without one, nothing shows the invariants can fail.`,
          },
        ]
      : []),
    ...expected.problems,
    ...models.flatMap((name) => missingText(specDirectory, name)),
    ...variants.flatMap((name) => missingText(brokenDirectory, name)),
    ...variants
      .filter((name) => !expected.entries.has(name))
      .map((name) => ({
        model: join(brokenDirectory, name),
        fix: `Add "${name}" to ${expectedPath} with the invariant it must break and why.`,
      })),
    ...[...expected.entries.keys()]
      .filter((name) => !variants.includes(name))
      .map((name) => ({
        model: expectedPath,
        fix: `Remove "${name}" from ${expectedPath}, or add ${join(brokenDirectory, `${name}.cfg`)}: the entry has no variant.`,
      })),
  ];
  const runnable = (directory, name) => existsSync(join(directory, `${name}.tla`));
  return {
    problems,
    checks: [
      ...models
        .filter((name) => runnable(specDirectory, name))
        .map((name) => ({ model: join(specDirectory, name), mustBreak: null })),
      ...variants
        .filter((name) => runnable(brokenDirectory, name) && expected.entries.has(name))
        .map((name) => ({ model: join(brokenDirectory, name), mustBreak: expected.entries.get(name) })),
    ],
  };
};

const runTlc = ({ jar, java }, model, scratch) => {
  const result = spawnSync(
    java,
    [
      "-XX:+UseParallelGC",
      "-cp",
      jar,
      "tlc2.TLC",
      "-workers",
      "1",
      "-noGenerateSpecTE",
      "-metadir",
      mkdtempSync(join(scratch, "states-")),
      "-config",
      `${model}.cfg`,
      `${model}.tla`,
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error !== undefined) throw new ToolchainError(`Cannot start Java at ${java}: ${result.error.message}`);
  const output = `${result.stdout}${result.stderr}`;
  const broken = output.match(/^Error: Invariant (\S+) is violated\.$/m)?.[1];
  const states = [...output.matchAll(/([\d,]+) distinct states? found/g)].at(-1)?.[1];
  if (result.status === 0 && output.includes("Model checking completed. No error has been found.")) {
    return { kind: "held", did: `found no error in ${states} states`, output };
  }
  if (result.status === 12 && broken !== undefined) return { kind: "broke", invariant: broken, did: `broke ${broken}`, output };
  return {
    kind: "unusable",
    did: TLC_EXIT_MEANING.get(result.status) ?? `TLC stopped with exit code ${result.status}`,
    output,
  };
};

const judge = ({ model, mustBreak }, outcome) => {
  if (mustBreak === null) {
    if (outcome.kind === "held") return null;
    return `Fix ${model}.tla or the code it describes: the model must pass. The steps TLC took are in its output above.`;
  }
  if (outcome.kind === "broke" && outcome.invariant === mustBreak) return null;
  if (outcome.kind === "held") {
    return `${model} must break ${mustBreak} but passed. Either the variant still has the protection it was meant to remove, or ${mustBreak} does not check what it claims to. Fix the model, never the expectation.`;
  }
  if (outcome.kind === "broke") {
    return `${model} must break ${mustBreak} but broke ${outcome.invariant} first. Remove only the one protection, or list the invariant that protection really guards in ${EXPECTED_FILE}.`;
  }
  return `${model} must break ${mustBreak}, but TLC could not check it. A variant that cannot be read proves nothing; fix the errors in TLC's output above.`;
};

const table = (rows) => {
  const header = ["Model", "Must", "Did", "Result"];
  const cells = [header, ...rows.map((row) => [row.model, row.must, row.did, row.fix === null ? "ok" : "FAIL"])];
  const widths = header.map((_, column) => Math.max(...cells.map((line) => line[column].length)));
  const format = (line) => line.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  return [format(cells[0]), widths.map((width) => "-".repeat(width)).join("  "), ...cells.slice(1).map(format)].join("\n");
};

const run = async (argv) => {
  if (argv.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.length > 1 || argv.some((argument) => argument.startsWith("-"))) {
    throw new ToolchainError(`Unexpected arguments "${argv.join(" ")}". Run with --help for usage.`);
  }
  const specDirectory = argv[0] ?? "spec";
  const { problems, checks } = plan(specDirectory);
  const toolchain = checks.length === 0 ? null : await tlaToolchain();
  const scratch = mkdtempSync(join(tmpdir(), "tlc-"));
  const checked = (() => {
    try {
      return checks.map((check) => {
        const outcome = runTlc(toolchain, check.model, scratch);
        const fix = judge(check, outcome);
        if (fix !== null) process.stdout.write(`TLC output for ${check.model}:\n${outcome.output}\n`);
        return {
          model: check.model,
          must: check.mustBreak === null ? "pass" : `break ${check.mustBreak}`,
          did: outcome.did,
          fix,
        };
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  const rows = [...problems.map(({ model, fix }) => ({ model, must: "be complete", did: "is not", fix })), ...checked];
  const failures = rows.filter((row) => row.fix !== null);
  process.stdout.write(`${table(rows)}\n\n`);
  for (const { fix } of failures) process.stdout.write(`FAIL: ${fix}\n`);
  process.stdout.write(
    failures.length === 0
      ? `tlc: ok. ${rows.length} of ${rows.length} models behaved as required.\n`
      : `tlc: ${failures.length} of ${rows.length} rows failed.\n`,
  );
  return failures.length === 0 ? 0 : 1;
};

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`tlc: ${error instanceof ToolchainError ? error.message : error.stack}\n`);
  process.exitCode = 2;
}
