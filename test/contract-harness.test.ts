import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { bundleOptions } from "@ambitious/kit/build/bundle-options";
import { build } from "esbuild";

test("the shared contract suite still rejects a binary that opens analysis databases for writing", async (t) => {
  mkdirSync(".build", { recursive: true });
  const scratch = mkdtempSync(resolve(".build/contract-mutation-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const binary = join(scratch, "broken-tasks.mjs");
  let changed = false;
  await build({ ...bundleOptions({ root: resolve("."), module: "tasks" }), outfile: binary,
    plugins: [{ name: "analysis-write-mutation", setup(builder) {
      builder.onLoad({ filter: /[/\\]db[/\\]open-db\.js$/ }, ({ path }) => {
        const source = readFileSync(path, "utf8");
        const declaration = "export const openDb = (path, { readonly }) => {";
        assert.equal(source.split(declaration).length, 2);
        changed = true;
        return { contents: source.replace(declaration, `${declaration}\n readonly = false;`), loader: "js", resolveDir: dirname(path) };
      });
    } }],
  });
  assert.equal(changed, true);
  const result = spawnSync(process.execPath, ["scripts/contract.mjs", binary], { encoding: "utf8", env: { ...process.env, TMPDIR: scratch } });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL\s+read-only-analysis/);
  assert.match(result.stdout, /a read command must not create the database/);
  assert.match(result.stdout, /ok\s+listed-shapes/);
  assert.match(result.stdout, /contract: 1 of 7 checks failed/);
});
