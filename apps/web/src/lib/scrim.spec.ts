import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sourceFiles(path);
        return /\.(tsx?|css)$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : [];
    });
}

describe('FR-CRMS-UI-9: the web app dims overlays with the scrim token only', () => {
    it('no page tints an overlay with the text colour (it lightens in dark mode)', () => {
        const offenders = sourceFiles(SRC).filter((f) => /\bbg-text\/\d/.test(readFileSync(f, 'utf8')));
        expect(offenders).toEqual([]);
    });
});
