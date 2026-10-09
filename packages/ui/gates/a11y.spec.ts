import { test } from '@playwright/test';
import { checkA11y, injectAxe } from 'axe-playwright';
import { openStory, stories } from './stories';

/**
 * The accessibility gate: axe runs on every story at WCAG 2.1 AA and any violation fails the
 * run. No rule is disabled here except the one below, under the one condition written beside
 * it — an exception is a line of code with its reason, reviewed like any other.
 *
 * The check runs on `body`, not `#storybook-root`: dialogs, menus and tooltips render through
 * portals outside the root, and a gate that cannot see a dialog is not a gate.
 */
const WCAG_21_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * A Radix modal layer (Select, Dialog, DropdownMenu while open) marks everything outside its
 * portal `aria-hidden` and keeps keyboard focus inside with its own focus scope. The trigger
 * left behind in `#storybook-root` is still a focusable element inside an aria-hidden subtree,
 * which axe's `aria-hidden-focus` reports; axe cannot see the focus scope that makes it
 * unreachable. The rule is switched off only for a story in which that layer is open — the
 * root itself carries `aria-hidden` — and stays on everywhere else, including the same
 * component's closed stories.
 */
const RADIX_MODAL_OPEN = '#storybook-root[aria-hidden="true"]';

for (const entry of stories()) {
    test(entry.id, async ({ page }) => {
        await openStory(page, entry.id);
        await injectAxe(page);
        const modalOpen = (await page.locator(RADIX_MODAL_OPEN).count()) > 0;
        await checkA11y(page, 'body', {
            detailedReport: true,
            detailedReportOptions: { html: true },
            axeOptions: {
                runOnly: { type: 'tag', values: WCAG_21_AA },
                rules: modalOpen ? { 'aria-hidden-focus': { enabled: false } } : {},
            },
        });
    });
}
