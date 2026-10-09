import { matchRoutes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from './manifest';
import { WORKSPACE_PARAM } from './params';
import { paths } from './paths';

/** Every declared path resolves to a real route, and only the catch-all answers for the rest. */
const ws = '11111111-2222-4333-8444-555555555555';

function matched(path: string): string[] {
    return (matchRoutes(routes, path) ?? []).map((m) => m.route.path ?? (m.route.index ? '(index)' : '(layout)'));
}

describe('route manifest', () => {
    it('declares every path in `paths`', () => {
        const all = Object.values(paths).map((p) => (typeof p === 'function' ? p(ws) : p));
        for (const path of all) {
            const leaf = matched(path).at(-1);
            expect(leaf, path).not.toBe('*');
        }
    });

    it('answers unknown paths with the catch-all', () => {
        expect(matched('/nope/nothing').at(-1)).toBe('*');
    });

    it('names the workspace segment the typed helper reads', () => {
        const match = matchRoutes(routes, paths.people(ws));
        expect(match?.find((m) => m.params[WORKSPACE_PARAM])?.params[WORKSPACE_PARAM]).toBe(ws);
    });

    it('puts every workspace route behind the auth boundary', () => {
        for (const path of [paths.workspaces, paths.home(ws), paths.settingsRoles(ws)]) {
            // The boundary is a pathless layout route; it shows up as "(layout)" in the chain.
            expect(matched(path)[0], path).toBe('(layout)');
        }
        expect(matched(paths.signIn)[0]).toBe(paths.signIn);
    });
});
