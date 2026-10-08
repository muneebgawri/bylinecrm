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
        server: {
            port: Number(env.WEB_PORT),
            strictPort: true,
            proxy: { '/api': { target: `http://127.0.0.1:${env.PORT}`, rewrite: (p) => p.replace(/^\/api/, '') } },
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
