import { test } from '@playwright/test';
import { openStory } from './stories';

/** TEMPORARY diagnostic — removed once the dark ghost-button rendering is explained. */
for (const id of [
    'components-button--gallery-dark',
    'components-datatableshell--gallery-dark',
    'components-button--gallery',
]) {
    test(`diag ${id}`, async ({ page }) => {
        await openStory(page, id);
        const report = await page.evaluate(() => {
            const html = document.documentElement;
            const buttons = Array.from(document.querySelectorAll('button')).map((b) => {
                const cs = getComputedStyle(b);
                return {
                    text: (b.textContent ?? '').trim().slice(0, 12),
                    color: cs.color,
                    bg: cs.backgroundColor,
                    cls: b.className
                        .split(' ')
                        .filter((c) => c.startsWith('text-') || c.startsWith('bg-'))
                        .join(' '),
                    anims: b.getAnimations().length,
                };
            });
            return {
                theme: html.getAttribute('data-theme'),
                rootVar: getComputedStyle(html).getPropertyValue('--bc-text').trim(),
                scheme: getComputedStyle(html).colorScheme,
                animations: document.getAnimations().length,
                buttons,
            };
        });
        console.log('DIAG ' + id + ' ' + JSON.stringify(report));
    });
}
