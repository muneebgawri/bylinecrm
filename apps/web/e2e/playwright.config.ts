import { defineConfig, devices } from '@playwright/test';
import { BREAKPOINT_PX } from '../../../packages/ui/src/lib/breakpoints';

/**
 * The route gate's harness (P0-10): the production build of the web app, served by `vite
 * preview`, visited in Chromium at three widths in both themes.
 *
 *   phone    375px — below the mobile breakpoint: the phone layout, touch targets, field text
 *            sizes, and a screenshot per state against a committed baseline
 *   tablet   the mobile breakpoint itself (768px): the first width with the full layout
 *   desktop  1280px
 *
 * The API is not running: every request is answered from fixtures inside the browser (api.ts).
 * Screenshots, like the design system's, are made on the CI runner and nowhere else (README,
 * "Route gate").
 */
const PORT = 4318;
const PHONE = { width: 375, height: 812 };
const TABLET = { width: BREAKPOINT_PX.mobile, height: 1024 };
const DESKTOP = { width: 1280, height: 800 };

const project = (
    name: string,
    viewport: { width: number; height: number },
    colorScheme: 'light' | 'dark',
    touch: boolean,
) => ({
    name,
    use: {
        ...devices['Desktop Chrome'],
        viewport,
        deviceScaleFactor: 1,
        colorScheme,
        hasTouch: touch,
        isMobile: false,
    },
});

export default defineConfig({
    testDir: '.',
    testMatch: 'routes.spec.ts',
    snapshotPathTemplate: '{testDir}/__snapshots__/{arg}{ext}',
    fullyParallel: true,
    retries: 0,
    timeout: 60_000,
    reporter: [[process.env.CI ? 'github' : 'list'], ['./reporter.ts']],
    outputDir: './test-results',
    expect: {
        toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 0, scale: 'css' },
    },
    use: { baseURL: `http://127.0.0.1:${PORT}` },
    projects: [
        project('phone-light', PHONE, 'light', true),
        project('phone-dark', PHONE, 'dark', true),
        project('tablet-light', TABLET, 'light', true),
        project('tablet-dark', TABLET, 'dark', true),
        project('desktop-light', DESKTOP, 'light', false),
        project('desktop-dark', DESKTOP, 'dark', false),
    ],
    webServer: {
        // The production build, as shipped; `--strictPort` so a busy port fails instead of moving.
        command: `vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: false,
        cwd: '..',
    },
});
