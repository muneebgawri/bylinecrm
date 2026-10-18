import type { Capability } from '@bylinecrm/shared';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { people } from '../../../../e2e/fixtures';
import { json, renderAt, route, stubApi } from '../settings/settingsTestKit';
import { PersonRecord } from './PersonRecord';

const WS = 'ws-1';
const person = people[0]!;

/** Every read the person page makes answers empty; nothing here is about the panels. */
const empty = () =>
    stubApi([
        (r) => {
            if (r.method !== 'GET') return undefined;
            if (/\/(enrolments|attachments)(\?|$)/.test(r.url)) return json([]);
            return json({ items: [], nextCursor: null });
        },
    ]);

const page = (capabilities: Capability[]) =>
    renderAt(
        [
            route(
                '/w/:workspaceId/people/:personId',
                <PersonRecord workspaceId={WS} person={person} layout="page" membersById={new Map()} />,
            ),
        ],
        `/w/${WS}/people/${person.id}`,
        capabilities,
    );

describe('#192 the person page’s “Enrol in sequence”', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('is not there at all for a role that cannot enrol', async () => {
        empty();
        page(['record:read', 'record:write', 'email:send']);
        expect(await screen.findByRole('heading', { name: 'Dana Reyes' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Enrol/ })).toBeNull();
    });

    it('is offered to a role that can', async () => {
        empty();
        page(['record:read', 'record:write', 'email:send', 'sequence:enrol']);
        expect((await screen.findAllByRole('button', { name: /Enrol/ }))[0]).toBeEnabled();
    });
});
