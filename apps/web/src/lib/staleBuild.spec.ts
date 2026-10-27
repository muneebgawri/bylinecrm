import { afterEach, describe, expect, it } from 'vitest';
import { isStaleBuild, mayReloadForNewBuild } from './staleBuild';

describe('staleBuild', () => {
    afterEach(() => sessionStorage.clear());

    it('knows a chunk a deploy removed from any other error', () => {
        expect(
            isStaleBuild(new TypeError('Failed to fetch dynamically imported module: https://x/assets/A-1.js')),
        ).toBe(true);
        expect(isStaleBuild(new TypeError('Importing a module script failed.'))).toBe(true);
        expect(isStaleBuild(new Error('Not found'))).toBe(false);
        expect(isStaleBuild('Failed to fetch dynamically imported module')).toBe(false);
    });

    it('reloads once a minute at most, so a real outage is shown rather than looped', () => {
        expect(mayReloadForNewBuild()).toBe(true);
        sessionStorage.setItem('bylinecrm:stale-build-reload', String(Date.now()));
        expect(mayReloadForNewBuild()).toBe(false);
        sessionStorage.setItem('bylinecrm:stale-build-reload', String(Date.now() - 61_000));
        expect(mayReloadForNewBuild()).toBe(true);
    });
});
