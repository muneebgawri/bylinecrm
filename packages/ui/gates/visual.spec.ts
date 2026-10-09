import { expect, test } from '@playwright/test';
import { openStory, stories } from './stories';

/** One screenshot per story, named by the story id so a failure names the story that moved. */
for (const entry of stories()) {
    test(entry.id, async ({ page }) => {
        await openStory(page, entry.id);
        await expect(page).toHaveScreenshot(`${entry.id}.png`, { fullPage: true });
    });
}
