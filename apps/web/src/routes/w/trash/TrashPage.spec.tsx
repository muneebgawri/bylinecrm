import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, renderAt, route, stubApi } from '../settings/settingsTestKit';
import { TrashPage } from './TrashPage';

const WS = 'ws-1';

const TRASHED = {
    id: 'p-1',
    nameFirst: 'Dana',
    nameLast: 'Reyes',
    emails: { primary: 'dana@example.test', additional: [] },
    ownerId: 'm-2',
    deletion: { at: '2026-11-13T09:00:00Z', reason: 'not_a_lead', note: 'A personal address.', byMemberId: 'm-2' },
};

const page = (items: unknown[]) => ({ items, nextCursor: null, total: items.length, totalIsExact: true });

const open = (capabilities: Parameters<typeof renderAt>[2]) =>
    renderAt([route('/w/:workspaceId/trash', <TrashPage />)], `/w/${WS}/trash`, capabilities);

describe('the trash: deleted records, who deleted them and why, and Restore', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('lists deleted people with who, why and the note, and puts one back', async () => {
        let restored = false;
        const seen = stubApi([
            (r) => (r.url.includes('/people/deleted') ? json(page(restored ? [] : [TRASHED])) : undefined),
            (r) => (r.url.includes('/companies/deleted') ? json(page([])) : undefined),
            (r) =>
                r.url.endsWith('/members/summary') ? json([{ memberId: 'm-2', name: 'Billy Example' }]) : undefined,
            (r) => {
                if (r.method !== 'POST' || !r.url.endsWith('/people/p-1/restore')) return undefined;
                restored = true;
                return json(TRASHED);
            },
        ]);
        open(['record:read', 'record:write']);
        expect(await screen.findByText('Dana Reyes')).toBeInTheDocument();
        expect(screen.getByText('dana@example.test')).toBeInTheDocument();
        expect(screen.getByText(/by Billy Example · Not a lead/)).toBeInTheDocument();
        expect(screen.getByText('“A personal address.”')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Restore Dana Reyes' }));
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/people/p-1/restore'))).toBe(true));
        expect(await screen.findByText('Nothing in the trash')).toBeInTheDocument();

        await userEvent.click(screen.getByRole('tab', { name: 'Companies' }));
        await waitFor(() => expect(seen.some((r) => r.url.includes('/companies/deleted'))).toBe(true));
    });

    it('keeps a record whose restore was refused', async () => {
        const seen = stubApi([
            (r) => (r.url.includes('/people/deleted') ? json(page([TRASHED])) : undefined),
            (r) => (r.url.endsWith('/members/summary') ? json([]) : undefined),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/restore')
                    ? json({ code: 'conflict', message: 'A person with that email exists.' }, 409)
                    : undefined,
        ]);
        open(['record:read', 'record:write']);
        await userEvent.click(await screen.findByRole('button', { name: 'Restore Dana Reyes' }));
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/people/p-1/restore'))).toBe(true));
        expect(screen.getByText('Dana Reyes')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Restore Dana Reyes' })).toBeEnabled();
    });

    it('is closed to a member who cannot change records', async () => {
        const seen = stubApi([]);
        open(['record:read']);
        expect(await screen.findByText('You cannot open the trash')).toBeInTheDocument();
        expect(seen.some((r) => r.url.includes('/deleted'))).toBe(false);
    });
});
