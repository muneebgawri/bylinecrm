/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Vitest only — the package ships source; Storybook has its own Vite config in `.storybook/main.ts`. */
export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['src/test/setup.ts'],
        include: ['src/**/*.spec.{ts,tsx}'],
        passWithNoTests: false,
    },
});
