import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface IndexEntry {
    id: string;
    type: 'story' | 'docs';
    title: string;
    name: string;
}

const indexPath = resolve(dirname(fileURLToPath(import.meta.url)), '../storybook-static/index.json');
if (!existsSync(indexPath)) {
    throw new Error('storybook-static/index.json not found — run `pnpm build-storybook` before `pnpm test:visual`.');
}
const entries = Object.values(JSON.parse(readFileSync(indexPath, 'utf8')).entries as Record<string, IndexEntry>).filter(
    (entry) => entry.type === 'story',
);

/** One test per story, named by the story id so a failing screenshot names the story that moved. */
for (const entry of entries) {
    test(entry.id, async ({ page }) => {
        await page.goto(`/iframe.html?id=${entry.id}&viewMode=story`);
        const root = page.locator('#storybook-root');
        await expect(root).not.toBeEmpty();
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`${entry.id}.png`, { fullPage: true });
    });
}
