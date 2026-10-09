import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BREAKPOINT_PX, MOBILE_QUERY } from './breakpoints';

/** The CSS (`max-md:`) and the script (`useIsMobile`) must switch at the same width. */
describe('breakpoints', () => {
    it('keeps Tailwind md and BREAKPOINT_PX.mobile equal', () => {
        const theme = readFileSync(resolve(__dirname, '../theme.css'), 'utf8');
        const rem = /--breakpoint-md:\s*([\d.]+)rem/.exec(theme)?.[1];
        expect(rem, 'theme.css declares --breakpoint-md').toBeDefined();
        expect(Number(rem) * 16).toBe(BREAKPOINT_PX.mobile);
    });

    it('matches below the mobile width only', () => {
        expect(MOBILE_QUERY).toBe('(max-width: 767.98px)');
    });
});
