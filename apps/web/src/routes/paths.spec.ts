import { describe, expect, it } from 'vitest';
import { isLocalPath, paths, returnToFrom, signInPath } from './paths';

describe('signInPath', () => {
    it('carries a same-origin return address and refuses anything else', () => {
        expect(signInPath('/w/1/people?x=1')).toBe(`${paths.signIn}?returnTo=${encodeURIComponent('/w/1/people?x=1')}`);
        expect(signInPath('https://evil.example/')).toBe(paths.signIn);
        expect(signInPath('//evil.example')).toBe(paths.signIn);
        expect(signInPath(paths.signIn)).toBe(paths.signIn);
        expect(signInPath()).toBe(paths.signIn);
    });
});

describe('returnToFrom', () => {
    it('reads a safe return address or falls back', () => {
        expect(returnToFrom('?returnTo=%2Fw%2F1%2Fdeals')).toBe('/w/1/deals');
        expect(returnToFrom('?returnTo=https%3A%2F%2Fevil.example')).toBe(paths.workspaces);
        expect(returnToFrom('')).toBe(paths.workspaces);
    });
});

describe('isLocalPath', () => {
    it('accepts one leading slash only', () => {
        expect(isLocalPath('/w/1')).toBe(true);
        expect(isLocalPath('//x')).toBe(false);
        expect(isLocalPath('/\\x')).toBe(false);
        expect(isLocalPath('w/1')).toBe(false);
    });
});
