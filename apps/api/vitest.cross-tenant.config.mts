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
        // No mail-sync, mail-send or calendar-sync worker: the suite drives sync and sending directly against a
        // fake Gmail and Calendar, and a worker started by any spec's application would call the real Google
        // with a fake token.
        // No transactional-mail relay (#93): a spec sends recorded mail itself (`test/support/mail.ts`)
        // into the in-process memory transport, so it knows when the mail has arrived.
        // Sign-up open (P0-14): nearly every spec makes its tenants through `/api/auth/signup`; the
        // specs for `closed` and `invite` replace the environment in their own application.
        env: {
            DB_QUERY_EVENTS: '1',
            MAIL_SYNC_WORKER: '0',
            MAIL_SEND_WORKER: '0',
            CALENDAR_SYNC_WORKER: '0',
            NOTIFICATIONS_WORKER: '0',
            SEQUENCE_WORKER: '0',
            TWENTY_IMPORT_WORKER: '0',
            ENRICHMENT_WORKER: '0',
            TRANSACTIONAL_MAIL_RELAY: '0',
            SIGNUP_MODE: 'open',
        },
        // One process: the suite shares one database and must not race itself.
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
