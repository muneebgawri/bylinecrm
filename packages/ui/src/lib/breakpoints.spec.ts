import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BREAKPOINTS, NARROW_QUERY, PHONE_QUERY } from './breakpoints';

const REM = 16;

describe('breakpoints', () => {
    it("holds Tailwind's md variant equal to the phone breakpoint", () => {
        const css = readFileSync(resolve(process.cwd(), 'src/theme.css'), 'utf8');
        const match = /--breakpoint-md:\s*([\d.]+)rem/.exec(css);
        expect(match).not.toBeNull();
        expect(Number(match?.[1]) * REM).toBe(BREAKPOINTS.phone);
    });

    it('builds the queries from the one definition', () => {
        expect(PHONE_QUERY).toBe(`(max-width: ${BREAKPOINTS.phone - 1}px)`);
        expect(NARROW_QUERY).toBe(`(max-width: ${BREAKPOINTS.shell}px)`);
    });
});
