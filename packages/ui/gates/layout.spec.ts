import { expect, test } from '@playwright/test';
import { openStory } from './stories';

/**
 * The layout gate: what a screenshot at one viewport cannot show. A dialog taller than the window must
 * scroll inside itself with its footer in view, at desktop and phone sizes alike — on 2026-10-24 the role
 * editor's "Create role" sat below an 812px-high window, unreachable (bylinecrm#271, FR-CRMS-UI-12).
 */
const SHORT_WINDOWS = [
    { name: 'short desktop', width: 1024, height: 600 },
    { name: 'phone', width: 390, height: 640 },
];

for (const size of SHORT_WINDOWS) {
    test(`a dialog taller than a ${size.name} window keeps its footer in view (#271)`, async ({ page }) => {
        await page.setViewportSize({ width: size.width, height: size.height });
        await openStory(page, 'components-dialog--tall');
        const dialog = page.getByRole('dialog', { name: 'New role' });
        const box = await dialog.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);

        const submit = dialog.getByRole('button', { name: 'Create role' });
        await expect(submit).toBeInViewport({ ratio: 1 });
        // Not covered by the scrolling body: a trial click hit-tests the point it would press.
        await submit.click({ trial: true, timeout: 2000 });

        // The body scrolls; the last permission is reachable and the footer is still in view after.
        await dialog.getByText('Permission 30', { exact: true }).scrollIntoViewIfNeeded();
        await expect(dialog.getByText('Permission 30', { exact: true })).toBeInViewport();
        await expect(submit).toBeInViewport({ ratio: 1 });
    });
}
