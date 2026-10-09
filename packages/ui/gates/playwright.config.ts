import { defineConfig, devices } from '@playwright/test';

/**
 * The two browser gates, one harness. Both run against the static Storybook build served on a
 * fixed port in Chromium at one viewport:
 *
 *   a11y    axe on every story at WCAG 2.1 AA — any violation fails (a11y.spec.ts)
 *   visual  a screenshot of every story against a committed baseline — ANY pixel fails
 *           (visual.spec.ts)
 *
 * Baselines are produced on the CI runner (see ../README.md, "Visual baselines"), never on a
 * developer machine — a Mac and a Linux runner rasterise text differently, so a local baseline
 * would fail in CI and vice versa. The snapshot path has no platform suffix for that reason:
 * there is exactly one baseline per story, and it is the runner's.
 */
const PORT = 6007;

export default defineConfig({
    testDir: '.',
    snapshotPathTemplate: '{testDir}/../__snapshots__/{arg}{ext}',
    fullyParallel: true,
    retries: 0,
    reporter: process.env.CI ? [['github'], ['list']] : 'list',
    outputDir: '../test-results',
    expect: {
        toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 0, scale: 'css' },
    },
    use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1024, height: 768 },
        deviceScaleFactor: 1,
        colorScheme: 'light',
        baseURL: `http://127.0.0.1:${PORT}`,
    },
    projects: [
        { name: 'a11y', testMatch: 'a11y.spec.ts' },
        { name: 'visual', testMatch: 'visual.spec.ts' },
    ],
    webServer: {
        // sirv-cli lets the PORT and HOST environment variables override its flags, so a shell (or
        // a CI job) that exports the API's PORT silently moves the server. The flags are the one
        // place the address is set; `env -u` makes sure nothing else is. --host is explicit because
        // `localhost` can resolve to ::1 while the probe asks 127.0.0.1.
        command: `env -u PORT -u HOST sirv storybook-static --host 127.0.0.1 --port ${PORT} --quiet`,
        url: `http://127.0.0.1:${PORT}/iframe.html`,
        reuseExistingServer: false,
        cwd: '..',
    },
});
