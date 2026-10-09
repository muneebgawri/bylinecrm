import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Unit suite: specs beside the code, no infrastructure. */
export default defineConfig({
    plugins: [
        // Nest relies on decorator metadata, which esbuild does not emit; swc does.
        swc.vite({ jsc: { transform: { legacyDecorator: true, decoratorMetadata: true } } }),
    ],
    test: {
        include: ['src/**/*.spec.ts'],
        passWithNoTests: false,
        environment: 'node',
        // Query budgets are test instruments: the client emits statement events only when asked.
        env: { DB_QUERY_EVENTS: '1' },
    },
});
