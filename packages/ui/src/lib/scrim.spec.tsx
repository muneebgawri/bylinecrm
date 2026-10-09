import { render } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '../components/dialog/Dialog';
import { Drawer, DrawerContent } from '../components/drawer/Drawer';

const SRC = join(__dirname, '..');
const tokens = readFileSync(join(SRC, 'tokens.css'), 'utf8');
const theme = readFileSync(join(SRC, 'theme.css'), 'utf8');

/** The `--bc-scrim` value inside the block that starts at `selector`. */
function scrimIn(selector: string): string | undefined {
    const at = tokens.indexOf(selector);
    if (at < 0) return undefined;
    const end = tokens.indexOf('}', at);
    return /--bc-scrim:\s*([^;]+);/.exec(tokens.slice(at, end))?.[1]?.trim();
}

/** `rgba(r, g, b, a)` → its parts. */
function rgba(value: string | undefined): [number, number, number, number] | undefined {
    const m = /rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/.exec(value ?? '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : undefined;
}

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sourceFiles(path);
        return /\.(tsx?|css)$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : [];
    });
}

/** The overlay element of an open Radix dialog: the fixed full-screen layer that is not the dialog. */
function overlay(): Element | undefined {
    return [...document.body.querySelectorAll('[data-state="open"]')].find(
        (el) => el.getAttribute('role') !== 'dialog' && el.className.includes('inset-0'),
    );
}

describe('FR-CRMS-UI-9: overlays dim the page in light and dark', () => {
    it('defines --bc-scrim for light, for the OS dark setting and for the explicit dark theme', () => {
        const light = rgba(scrimIn(':root {'));
        const darkOs = rgba(scrimIn(":root:not([data-theme='light'])"));
        const darkExplicit = rgba(scrimIn(":root[data-theme='dark']"));
        expect(light, 'light --bc-scrim').toBeDefined();
        expect(darkOs, 'dark (OS) --bc-scrim').toBeDefined();
        expect(darkOs, 'the two dark blocks agree').toEqual(darkExplicit);
        // A scrim dims: a near-black colour in both themes, the dark theme's more opaque.
        for (const [r, g, b] of [light!, darkOs!]) expect(Math.max(r, g, b)).toBeLessThanOrEqual(40);
        expect(darkOs![3]).toBeGreaterThan(light![3]);
    });

    it('maps the token to the bg-scrim utility', () => {
        expect(theme).toMatch(/--color-scrim:\s*var\(--bc-scrim\)/);
    });

    it('Dialog and Drawer overlays use bg-scrim', () => {
        const dialog = render(
            <Dialog open>
                <DialogContent aria-describedby={undefined}>
                    <DialogTitle>Delete deal?</DialogTitle>
                </DialogContent>
            </Dialog>,
        );
        expect(overlay()?.className).toContain('bg-scrim');
        dialog.unmount();

        render(
            <Drawer open>
                <DrawerContent title="Dana Reyes">body</DrawerContent>
            </Drawer>,
        );
        expect(overlay()?.className).toContain('bg-scrim');
    });

    it('no component tints an overlay with the text colour (it lightens in dark mode)', () => {
        const offenders = sourceFiles(SRC).filter((f) => /\bbg-text\/\d/.test(readFileSync(f, 'utf8')));
        expect(offenders).toEqual([]);
    });
});
