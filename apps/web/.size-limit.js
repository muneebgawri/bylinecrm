import { readFileSync } from 'node:fs';

/**
 * The bundle budget (FR-CRMS-UI-10). "Initial JS" is exactly what `dist/index.html` loads before
 * first paint — its entry script and every modulepreload — read from the built HTML, so a chunk
 * Rollup names differently next time is still counted. A glob of chunk names undercounted once
 * (P1-UI-4): a shared chunk every page preloaded was in no pattern.
 */
const html = readFileSync(new URL('./dist/index.html', import.meta.url), 'utf8');
const initial = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => `dist/${m[1]}`);

export default [
    {
        name: 'initial JS (everything index.html loads before first paint, gzip)',
        path: initial,
        limit: '190 kB',
        gzip: true,
    },
    { name: 'stylesheet (gzip)', path: 'dist/assets/*.css', limit: '40 kB', gzip: true },
];
