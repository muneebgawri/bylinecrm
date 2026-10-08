import tailwindcss from '@tailwindcss/vite';
import type { StorybookConfig } from '@storybook/react-vite';

/**
 * Storybook is the design system's workbench and its test surface: the a11y gate and the visual
 * gate both run against the static build of these stories. It is a package-level tool and never
 * part of `apps/web`'s bundle.
 */
const config: StorybookConfig = {
    framework: '@storybook/react-vite',
    stories: ['../src/**/*.stories.tsx'],
    addons: [],
    core: { disableTelemetry: true },
    viteFinal: (viteConfig) => ({
        ...viteConfig,
        plugins: [...(viteConfig.plugins ?? []), tailwindcss()],
    }),
};

export default config;
