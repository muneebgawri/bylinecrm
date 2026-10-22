import type { Capability } from '@bylinecrm/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const page = (capabilities: Capability[], shown = person) =>
    renderAt(
        [
            route(
                '/w/:workspaceId/people/:personId',
                <PersonRecord workspaceId={WS} person={shown} layout="page" membersById={new Map()} />,
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

describe('PNW-766 a person’s NewswireOS client', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('is shown read-only once a won-deal push set it', async () => {
        empty();
        page(['record:read', 'record:write'], { ...person, newswireosCustomerId: 'cus_42' });
        expect(await screen.findByText('NewswireOS client')).toBeInTheDocument();
        expect(screen.getByText('cus_42').tagName).toBe('SPAN');
    });

    it('has no row while it is unset', async () => {
        empty();
        page(['record:read', 'record:write']);
        expect(await screen.findByRole('heading', { name: 'Dana Reyes' })).toBeInTheDocument();
        expect(screen.queryByText('NewswireOS client')).toBeNull();
    });
});

describe('a person’s other email addresses', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('are added from the properties: the address joins the others', async () => {
        const seen = stubApi([
            (r) =>
                r.method === 'PATCH' ? json({ ...person, emails: (r.body as { emails: unknown }).emails }) : undefined,
            (r) => {
                if (r.method !== 'GET') return undefined;
                if (/\/(enrolments|attachments|members\/summary|transfers|custom-fields)(\?|$)/.test(r.url))
                    return json([]);
                return json({ items: [], nextCursor: null });
            },
        ]);
        page(['record:read', 'record:write']);
        await userEvent.click(await screen.findByRole('button', { name: /Add email/ }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Add email' }), 'dana.home@example.com{Enter}');
        const patch = seen.find((r) => r.method === 'PATCH');
        expect((patch?.body as { emails?: unknown } | undefined)?.emails).toEqual({
            ...person.emails,
            additional: [...person.emails.additional, 'dana.home@example.com'],
        });
    });
});
