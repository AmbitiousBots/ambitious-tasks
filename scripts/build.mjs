import { join } from 'node:path';
import { isBuiltin } from 'node:module';
import { bundleOptions } from '@ambitious/kit/build/bundle-options';
import { build } from 'esbuild';

const result = await build({ ...bundleOptions({ root: join(import.meta.dirname, '..'), module: 'tasks' }), metafile: true });
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !isBuiltin(dependency.path)) throw new Error(`The executable still depends on ${dependency.path}. Bundle every runtime dependency.`);
  }
}
