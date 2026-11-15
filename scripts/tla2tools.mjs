#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE = `Usage: node scripts/tla2tools.mjs

Makes the pinned TLA+ tools ready and prints the path of tla2tools.jar.

The pin is two values in the [env] table of .mise.toml at the repository root:
TLA2TOOLS_URL (the exact download address) and TLA2TOOLS_SHA256 (the SHA-256
of the file). The file is downloaded once into a cache directory and its hash
is checked on every run. A file whose hash differs from the pin is refused and
never used.

The cache directory is $TLA2TOOLS_CACHE_DIR, or tla2tools under
$XDG_CACHE_HOME, or ~/.cache/tla2tools.

Needs mise (https://mise.jdx.dev), which reads .mise.toml and installs the
pinned Java: run "mise trust && mise install" once in the repository.

Exit code 0: ready. 2: the tools could not be made ready.
`;

const PIN_FILE = ".mise.toml";
const SETUP = `Install mise (https://mise.jdx.dev), then run "mise trust && mise install" in this repository.`;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const repoRoot = join(import.meta.dirname, "..");

export class ToolchainError extends Error {}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const pinnedEnvironment = () => {
  try {
    return JSON.parse(
      execFileSync("mise", ["env", "--json"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    );
  } catch (error) {
    throw new ToolchainError(
      `Cannot read the pinned toolchain from ${PIN_FILE}: ${String(error.stderr || error.message).trim()}\n${SETUP}`,
    );
  }
};

const pinFrom = (environment) => {
  const url = environment.TLA2TOOLS_URL;
  const hash = environment.TLA2TOOLS_SHA256;
  if (typeof url !== "string" || url === "") {
    throw new ToolchainError(`Set TLA2TOOLS_URL in the [env] table of ${PIN_FILE} to the exact address of tla2tools.jar.`);
  }
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new ToolchainError(
      `Set TLA2TOOLS_SHA256 in the [env] table of ${PIN_FILE} to the SHA-256 of tla2tools.jar: 64 lowercase hexadecimal characters.`,
    );
  }
  return { url, hash };
};

const cacheDirectory = () =>
  process.env.TLA2TOOLS_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "tla2tools");

const download = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new ToolchainError(`Cannot download tla2tools.jar from ${url}: ${error.message}`);
  }
};

const verifiedJar = async ({ url, hash }) => {
  const directory = cacheDirectory();
  const path = join(directory, `tla2tools-${hash}.jar`);
  if (existsSync(path)) {
    const found = sha256(readFileSync(path));
    if (found !== hash) {
      throw new ToolchainError(
        `Refusing the cached file ${path}: its SHA-256 is ${found}, but ${PIN_FILE} pins ${hash}. The file changed after it was downloaded. Delete it and run again.`,
      );
    }
    return path;
  }
  const bytes = await download(url);
  const found = sha256(bytes);
  if (found !== hash) {
    throw new ToolchainError(
      `Refusing the download from ${url}: its SHA-256 is ${found}, but ${PIN_FILE} pins ${hash}. Nothing was saved. To move to a new version on purpose, change TLA2TOOLS_URL and TLA2TOOLS_SHA256 together.`,
    );
  }
  mkdirSync(directory, { recursive: true });
  const partial = `${path}.${process.pid}.part`;
  writeFileSync(partial, bytes);
  renameSync(partial, path);
  return path;
};

export const tlaToolchain = async () => {
  const environment = pinnedEnvironment();
  const jar = await verifiedJar(pinFrom(environment));
  const javaHome = environment.JAVA_HOME;
  if (typeof javaHome !== "string" || !existsSync(join(javaHome, "bin", "java"))) {
    throw new ToolchainError(`The Java version pinned in ${PIN_FILE} is not installed. ${SETUP}`);
  }
  return { jar, java: join(javaHome, "bin", "java") };
};

if (import.meta.main) {
  try {
    if (process.argv.length > 2) {
      process.stdout.write(USAGE);
      process.exitCode = process.argv[2] === "--help" ? 0 : 2;
    } else {
      const { jar } = await tlaToolchain();
      process.stdout.write(`${jar}\n`);
    }
  } catch (error) {
    process.stderr.write(`tla2tools: ${error instanceof ToolchainError ? error.message : error.stack}\n`);
    process.exitCode = 2;
  }
}
