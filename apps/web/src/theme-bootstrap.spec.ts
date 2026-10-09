// @vitest-environment node
// This spec reads index.html from disk and asserts on its text; it needs Node, not a DOM.
import { DENSITY_ATTRIBUTE, DENSITY_STORAGE_KEY, THEME_ATTRIBUTE, THEME_STORAGE_KEY } from '@bylinecrm/ui';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * index.html's inline bootstrap cannot import the theme module, so it repeats the storage keys
 * and attribute names as literals. This test is what keeps the two copies one definition.
 */
describe('theme bootstrap in index.html', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

    it('reads the same storage keys the ThemeProvider writes', () => {
        expect(html).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
        expect(html).toContain(`localStorage.getItem('${DENSITY_STORAGE_KEY}')`);
    });

    it('writes the same attributes tokens.css reads', () => {
        expect(html).toContain(`setAttribute('${THEME_ATTRIBUTE}'`);
        expect(html).toContain(`setAttribute('${DENSITY_ATTRIBUTE}'`);
    });
});
