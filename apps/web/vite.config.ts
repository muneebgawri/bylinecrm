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
                    // names a stable file; routes split on their own through `lazy`. Only React
                    // Query is framework: TanStack Table and Virtual belong to the pages that use
                    // them (deals), not to every page's first load.
                    // The design system (and the Radix primitives under it) is a `ui` chunk of its
                    // own for the same reason — except the toast renderer, which loads lazily.
                    manualChunks: (id) => {
                        if (
                            /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(react|react-dom|scheduler|react-router|@tanstack\/(react-query|query-core))\//.test(
                                id,
                            )
                        )
                            return 'vendor';
                        if (/react-toast|components\/toast\/Toaster/.test(id)) return undefined;
                        // Popover and Sheet are imported by lazy pages only, through their own
                        // subpaths (see packages/ui/src/index.ts), so they load with those pages.
                        if (/components\/(popover|sheet)\/|@radix-ui\/react-popover\//.test(id)) return undefined;
                        if (/packages\/ui\/src\/|node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?@radix-ui\//.test(id))
                            return 'ui';
                        return undefined;
                    },
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
