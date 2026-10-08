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
    },
});
