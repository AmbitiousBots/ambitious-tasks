import { join } from 'node:path';
import { bundleOptions } from '@ambitious/kit/build/bundle-options';
import { build } from 'esbuild';

await build(bundleOptions({ root: join(import.meta.dirname, '..'), module: 'tasks' }));
