import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Cross-tenant suite (doc 49 §4): boots the real application against real Postgres and Redis.
 * It is a CI gate from P0-2 onward; in P0-1 it holds the boot smoke test that proves the harness
 * works. `passWithNoTests` is false on purpose — an empty gate is a dead gate.
 */
export default defineConfig({
    plugins: [swc.vite({ jsc: { transform: { legacyDecorator: true, decoratorMetadata: true } } })],
    test: {
        include: ['test/cross-tenant/**/*.spec.ts'],
        passWithNoTests: false,
        environment: 'node',
        // The list query-budget test (no N+1) counts statements; the client emits them only when asked.
        env: { DB_QUERY_EVENTS: '1' },
        // One process: the suite shares one database and must not race itself.
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
