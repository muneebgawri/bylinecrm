import { expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The list of stories both gates iterate, read from the static build's index so the gates see
 * exactly what the build contains — a story that is in Storybook is in the gates, with no list
 * to keep in step.
 */
export interface StoryEntry {
    id: string;
    type: 'story' | 'docs';
    title: string;
    name: string;
}

const indexPath = resolve(dirname(fileURLToPath(import.meta.url)), '../storybook-static/index.json');

export function stories(): StoryEntry[] {
    if (!existsSync(indexPath)) {
        throw new Error('storybook-static/index.json not found — run `pnpm build-storybook` before the gates.');
    }
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { entries: Record<string, StoryEntry> };
    return Object.values(index.entries).filter((entry) => entry.type === 'story');
}

/** Opens one story in the preview iframe and waits until it has rendered and its fonts are in. */
export async function openStory(page: Page, id: string): Promise<void> {
    await page.goto(`/iframe.html?id=${id}&viewMode=story`);
    await expect(page.locator('#storybook-root')).not.toBeEmpty();
    await page.evaluate(() => document.fonts.ready);
}
