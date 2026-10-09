import { test } from '@playwright/test';
import { checkA11y, injectAxe } from 'axe-playwright';
import { openStory, stories } from './stories';

/**
 * The accessibility gate: axe runs on every story at WCAG 2.1 AA and any violation fails the
 * run. No rule is disabled here. If a rule ever must be, the disabling goes in this file with
 * the reason beside it, so the exception is reviewed like any other line of code.
 *
 * The check runs on `body`, not `#storybook-root`: dialogs, menus and tooltips render through
 * portals outside the root, and a gate that cannot see a dialog is not a gate.
 */
const WCAG_21_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

for (const entry of stories()) {
    test(entry.id, async ({ page }) => {
        await openStory(page, entry.id);
        await injectAxe(page);
        await checkA11y(page, 'body', {
            detailedReport: true,
            detailedReportOptions: { html: true },
            axeOptions: { runOnly: { type: 'tag', values: WCAG_21_AA } },
        });
    });
}
