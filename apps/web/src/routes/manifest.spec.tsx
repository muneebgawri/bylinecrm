import { matchPath, matchRoutes, type RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../shell/AppShell';
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
        // A path builder takes the workspace id and, for a record page, the record id.
        const all = Object.values(paths).map((p) =>
            typeof p === 'function' ? (p as (...ids: string[]) => string)(ws, ws) : p,
        );
        for (const path of all) {
            const leaf = matched(path).at(-1);
            expect(leaf, path).not.toBe('*');
        }
    });

    it('has a `paths` entry for every page it declares (the route gate visits `paths`)', () => {
        // Walk the manifest to its pages, joining nested paths; a layout or index route is not a page.
        const pages: string[] = [];
        const walk = (list: RouteObject[], prefix: string) => {
            for (const route of list) {
                const full = route.path ? `${prefix.replace(/\/$/, '')}/${route.path.replace(/^\//, '')}` : prefix;
                if (route.children) walk(route.children, full);
                else if (route.path && route.path !== '*') pages.push(full);
            }
        };
        walk(routes, '');
        expect(pages.length, 'the walk found the pages').toBeGreaterThan(20);
        const built = Object.values(paths).map((p) =>
            typeof p === 'function' ? (p as (...ids: string[]) => string)(ws, ws) : p,
        );
        for (const pattern of pages) {
            const covered = built.some((path) => matchPath(pattern, path));
            expect(covered, `${pattern} is in the manifest but no \`paths\` entry builds it`).toBe(true);
        }
    });

    it('answers unknown paths with the catch-all', () => {
        expect(matched('/nope/nothing').at(-1)).toBe('*');
    });

    it('names the workspace segment the typed helper reads', () => {
        const match = matchRoutes(routes, paths.people(ws));
        expect(match?.find((m) => m.params[WORKSPACE_PARAM])?.params[WORKSPACE_PARAM]).toBe(ws);
    });

    it('puts every signed-in route behind a sign-in guard', () => {
        // Outside a workspace the guard is RequireAuth, a pathless layout route ("(layout)").
        expect(matched(paths.workspaces)[0]).toBe('(layout)');
        expect(matched(paths.platformWorkspaces)[0]).toBe('(layout)');
        // Inside one it is the shell itself (useAuthGate): it draws its frame at once and holds the
        // content area until the person is known (P1-UI-10, FR-CRMS-UI-7).
        for (const path of [paths.home(ws), paths.settingsRoles(ws), paths.person(ws, ws)]) {
            const chain = matchRoutes(routes, path) ?? [];
            expect(chain[0]?.route.path, path).toBe(`/w/:${WORKSPACE_PARAM}`);
            expect((chain[0]?.route.element as { type?: unknown } | undefined)?.type, path).toBe(AppShell);
        }
        expect(matched(paths.signIn)[0]).toBe(paths.signIn);
    });
});
