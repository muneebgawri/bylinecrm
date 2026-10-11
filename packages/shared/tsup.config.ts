import { defineConfig } from 'tsup';

/**
 * Two builds of one source (#131):
 * - ESM, one file per source module (`bundle: false`), for the web app and the repo scripts. With
 *   `sideEffects: false` in package.json the web bundler places each module in the chunk of the
 *   pages that use it, so the first load carries only what the first frame imports.
 * - CommonJS, one bundled file, for the API (Nest compiles to CommonJS and `require`s it).
 * `clean` is off in both: they write to one directory concurrently; the build script clears it first.
 */
export default defineConfig([
    { entry: ['src/**/*.ts'], format: ['esm'], bundle: false, dts: true, outDir: 'dist', clean: false },
    { entry: { index: 'src/index.ts' }, format: ['cjs'], dts: true, outDir: 'dist', clean: false },
]);
