import { expect, test, type Page } from '@playwright/test';
import { BREAKPOINT_PX } from '../../../packages/ui/src/lib/breakpoints';
import { installApi } from './api';
import { axe, phoneTables, phoneTargets, primaryAction, sidewaysScroll, type Finding } from './checks';
import { FIXED_NOW } from './fixtures';
import { STATES } from './states';

/**
 * The route gate (P0-10, doc 48 FR-CRMS-UI-8 and FR-CRMS-UI-12): every page of the app, plus the
 * record drawer and the ⌘K palette, at each width and theme in playwright.config.ts.
 *
 * Each state is opened with the API answered from fixtures (api.ts) and the clock fixed, so the
 * page renders real content the same way every run. Then: axe at WCAG 2.1 AA, no sideways page
 * scroll, the primary action on screen, and — below the phone breakpoint — touch targets, field
 * text sizes and no tables (records are cards on a phone). Findings go to the report table (reporter.ts); any finding fails the state.
 * On phone widths the state is also compared with its committed screenshot.
 */
const PALETTE_SHORTCUT = 'ControlOrMeta+k';
const SETTLE_TIMEOUT_MS = 20_000;
/** How long the page must stay quiet to count as settled, and how often that is checked. */
const QUIET_MS = 500;
const POLL_MS = 100;

for (const state of STATES) {
    test(state.name, async ({ page }, testInfo) => {
        const unanswered = await installApi(page);
        const inFlight = trackRequests(page);
        await page.clock.setFixedTime(FIXED_NOW);
        await page.goto(state.url);
        await settle(page, inFlight);
        if (state.after === 'palette') {
            await page.keyboard.press(PALETTE_SHORTCUT);
            await expect(page.getByRole('dialog')).toBeVisible();
            await settle(page, inFlight);
        }

        const viewport = page.viewportSize();
        const phone = viewport !== null && viewport.width < BREAKPOINT_PX.mobile;
        const primary = await primaryAction(page);
        const findings: Finding[] = [
            ...(await axe(page)),
            ...(await sidewaysScroll(page)),
            ...primary.findings,
            ...(phone ? await phoneTargets(page) : []),
            ...(phone ? await phoneTables(page) : []),
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

/** Counts the page's requests still in flight (route-intercepted ones included). */
function trackRequests(page: Page): () => number {
    let inFlight = 0;
    page.on('request', () => inFlight++);
    const done = () => inFlight--;
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    return () => inFlight;
}

/**
 * The page is settled: fonts loaded, then no request in flight and nothing marked busy for
 * QUIET_MS without a break. A single quiet moment is not enough — a lazy chunk (the record
 * drawer) can finish loading and only then start its queries, and a check that landed between
 * the two would read a half-loaded page. `waitForLoadState('networkidle')` cannot express this:
 * once a page has been idle it returns at once.
 */
async function settle(page: Page, inFlight: () => number): Promise<void> {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let quietSince: number | null = null;
    while (Date.now() < deadline) {
        const busy = await page.locator('[aria-busy="true"]').count();
        if (inFlight() === 0 && busy === 0) {
            quietSince ??= Date.now();
            if (Date.now() - quietSince >= QUIET_MS) return;
        } else {
            quietSince = null;
        }
        await page.waitForTimeout(POLL_MS);
    }
    throw new Error(`the page did not settle within ${SETTLE_TIMEOUT_MS}ms (${inFlight()} requests in flight)`);
}
