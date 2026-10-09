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

/**
 * Opens one story in the preview iframe and waits until Storybook says it has rendered. The
 * signal is Storybook's own `sb-show-main` class on `body` (it sets `sb-show-errordisplay`
 * instead when the story throws), not the contents of `#storybook-root`: a story whose whole
 * output is a portal — a dialog, the ⌘K palette — leaves the root empty by design.
 */
export async function openStory(page: Page, id: string): Promise<void> {
    await page.goto(`/iframe.html?id=${id}&viewMode=story`);
    const body = page.locator('body');
    await expect(body).toHaveClass(/sb-show-main/);
    await expect(body, `story ${id} threw while rendering`).not.toHaveClass(/sb-show-errordisplay/);
    await page.evaluate(() => document.fonts.ready);
}
