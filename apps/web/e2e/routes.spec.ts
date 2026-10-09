import { expect, test } from '@playwright/test';
import { BREAKPOINT_PX } from '../../../packages/ui/src/lib/breakpoints';
import { installApi } from './api';
import { axe, phoneTargets, primaryAction, sidewaysScroll, type Finding } from './checks';
import { FIXED_NOW } from './fixtures';
import { STATES } from './states';

/**
 * The route gate (P0-10, doc 48 FR-CRMS-UI-8 and FR-CRMS-UI-12): every page of the app, plus the
 * record drawer and the ⌘K palette, at each width and theme in playwright.config.ts.
 *
 * Each state is opened with the API answered from fixtures (api.ts) and the clock fixed, so the
 * page renders real content the same way every run. Then: axe at WCAG 2.1 AA, no sideways page
 * scroll, the primary action on screen, and — below the phone breakpoint — touch targets and
 * field text sizes. Findings go to the report table (reporter.ts); any finding fails the state.
 * On phone widths the state is also compared with its committed screenshot.
 */
const PALETTE_SHORTCUT = 'ControlOrMeta+k';
const SETTLE_TIMEOUT_MS = 20_000;

for (const state of STATES) {
    test(state.name, async ({ page }, testInfo) => {
        const unanswered = await installApi(page);
        await page.clock.setFixedTime(FIXED_NOW);
        await page.goto(state.url);
        await settle(page);
        if (state.after === 'palette') {
            await page.keyboard.press(PALETTE_SHORTCUT);
            await expect(page.getByRole('dialog')).toBeVisible();
            await settle(page);
        }

        const viewport = page.viewportSize();
        const phone = viewport !== null && viewport.width < BREAKPOINT_PX.mobile;
        const primary = await primaryAction(page);
        const findings: Finding[] = [
            ...(await axe(page)),
            ...(await sidewaysScroll(page)),
            ...primary.findings,
            ...(phone ? await phoneTargets(page) : []),
            ...unanswered.map((u) => ({
                check: 'axe' as const,
                detail: `unanswered API call ${u.method} ${u.path}: ${u.reason}`,
            })),
        ];

        testInfo.annotations.push({
            type: 'route-gate',
            description: JSON.stringify({
                url: page.url().replace(/^https?:\/\/[^/]+/, ''),
                primary: primary.present,
                findings,
            }),
        });

        if (phone) {
            const theme = testInfo.project.use.colorScheme ?? 'light';
            await expect(page).toHaveScreenshot(`${state.name}-${theme}.png`);
        }
        expect(unanswered, 'every API call the page makes is answered by a fixture').toEqual([]);
        expect(findings, `${state.name} at ${viewport?.width ?? '?'}px`).toEqual([]);
    });
}

/** The page has loaded its data, its lazy chunks and its fonts, and nothing is still loading. */
async function settle(page: import('@playwright/test').Page): Promise<void> {
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // A lazy route chunk plus its queries can take longer than expect's 5s default on a loaded
    // runner; the gate is about the settled page, so it waits for it rather than flaking.
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: SETTLE_TIMEOUT_MS });
}
