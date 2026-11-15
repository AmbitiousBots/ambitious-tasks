import { randomInt } from "node:crypto";
import { cliEnvelope, type ModuleSpec } from "@ambitious/kit/cli/run-cli";
import { parseArgs } from "@ambitious/kit/domain/args";
import { MAX_SEED } from "@ambitious/kit/domain/clock";
import { envelope, exitCodeOf, serialize } from "@ambitious/kit/domain/envelope";

export const runModule = async (spec: ModuleSpec, optionalInput: ReadonlySet<string>): Promise<void> => {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const readStdin = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    if (!process.stdin.isTTY) {
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const value = Buffer.concat(chunks).toString("utf8");
    return value.trim() === "" && parsed.flags.in === null && optionalInput.has(parsed.words.join(" ")) ? "{}" : value;
  };
  const result = await cliEnvelope(spec, {
    argv,
    env: process.env,
    binaryPath: process.argv[1] ?? "",
    readStdin,
    systemNow: () => new Date(),
    systemSeed: () => randomInt(0, MAX_SEED + 1),
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    return envelope.err({ schemaVersion: spec.schemaVersion, module: spec.module, command: "",
      meta: { now: new Date().toISOString(), seed: 0, version: spec.version } },
    [{ code: "E_INTERNAL", message: "The module hit an unexpected error.", hint: "Report it with the stderr log." }]);
  });
  process.stdout.write(serialize(result));
  process.exitCode = exitCodeOf(result);
};
