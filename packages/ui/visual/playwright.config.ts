import { defineConfig, devices } from '@playwright/test';

/**
 * The visual gate. Every story in the static Storybook build is screenshotted at one viewport
 * in one browser and compared to a committed baseline; ANY pixel difference fails. Baselines
 * are produced on the CI runner (see ../README.md, "Visual baselines"), never on a developer
 * machine — a Mac and a Linux runner rasterise text differently, so a locally generated baseline
 * would fail in CI and vice versa. The snapshot path has no platform suffix for that reason:
 * there is exactly one baseline per story, and it is the runner's.
 */
export default defineConfig({
    testDir: '.',
    testMatch: 'stories.spec.ts',
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
        baseURL: 'http://127.0.0.1:6007',
    },
    webServer: {
        command: 'sirv storybook-static --port 6007 --quiet',
        url: 'http://127.0.0.1:6007/iframe.html',
        reuseExistingServer: false,
        cwd: '..',
    },
});
