/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * The web app reads the root `.env` (one file for the whole local stack): `WEB_PORT` for itself,
 * `PORT` to find the API for the dev proxy. In production the edge routes `/api` to the API and
 * the proxy is not used.
 */
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '../..', '');
    return {
        plugins: [react(), tailwindcss()],
        build: {
            rollupOptions: {
                output: {
                    // One `vendor` chunk for the framework so the size budget (.size-limit.json)
                    // names a stable file; routes split on their own through `lazy`.
                    manualChunks: (id) =>
                        /node_modules\/(react|react-dom|scheduler|react-router|@tanstack)\//.test(id)
                            ? 'vendor'
                            : undefined,
                },
            },
        },
        server: {
            port: Number(env.WEB_PORT),
            strictPort: true,
            // The API serves everything under `/api` (its global prefix) and `/health` on its own; both
            // are forwarded as-is, the same two routes the production edge sends to the API.
            proxy: {
                '/api': { target: `http://127.0.0.1:${env.PORT}` },
                '/health': { target: `http://127.0.0.1:${env.PORT}` },
            },
        },
        test: {
            environment: 'jsdom',
            globals: true,
            setupFiles: ['src/test/setup.ts'],
            include: ['src/**/*.spec.{ts,tsx}'],
            passWithNoTests: false,
        },
    };
});
