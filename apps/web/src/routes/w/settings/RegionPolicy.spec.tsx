import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegionPolicyChangeView, RegionPolicyEntryView } from '../../../api/types';
import { json, renderAt, route, stubApi, type FakeRoute } from './settingsTestKit';
import { RegionPolicy } from './RegionPolicy';

const entry = (region: RegionPolicyEntryView['region'], allowed: boolean): RegionPolicyEntryView => ({
    region,
    allowed,
    isDefault: true,
    lawfulBasis: null,
    updatedAt: null,
});

const policy: RegionPolicyEntryView[] = [
    entry('eu', false),
    entry('uk', false),
    entry('ca', false),
    entry('us', true),
    entry('other', true),
    entry('unknown', true),
];

const changes: RegionPolicyChangeView[] = [
    {
        id: 'c1',
        region: 'ca',
        allowed: false,
        lawfulBasis: null,
        changedBy: 'Dana Reyes',
        changedAt: '2026-10-11T10:00:00Z',
    },
];

const listed: FakeRoute = (r) => {
    if (r.method !== 'GET') return undefined;
    if (r.url.endsWith('/outreach/region-policy/changes')) return json(changes);
    if (r.url.endsWith('/outreach/region-policy')) return json(policy);
    return undefined;
};

const open = (capabilities: Parameters<typeof renderAt>[2]) =>
    renderAt(
        [route('/w/:workspaceId/settings/region-policy', <RegionPolicy />)],
        '/w/ws-1/settings/region-policy',
        capabilities,
    );

describe('#141 FR-CRMS-12 Settings → Region policy', { timeout: 20_000 }, () => {
    afterEach(() => vi.unstubAllGlobals());

    it('shows each region allowed or blocked, the unknown-country rule, and who changed what', async () => {
        stubApi([listed]);
        open(['outreach:write']);
        const eu = await screen.findByRole('row', { name: /EU/ });
        expect(within(eu).getByText('Blocked')).toBeInTheDocument();
        expect(within(screen.getByRole('row', { name: /^US/ })).getByText('Allowed')).toBeInTheDocument();
        // D-251: unknown is allowed, and enrolment flags each such person.
        expect(screen.getByText(/flagged in the enrolment preview/i)).toBeInTheDocument();
        expect(screen.getByText('Dana Reyes')).toBeInTheDocument();
        // A member who is not an admin reads but cannot change.
        expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    });

    it('opens a region blocked by default only with a lawful basis, after confirming', async () => {
        const seen = stubApi([
            listed,
            (r) => (r.method === 'PUT' && r.url.endsWith('/outreach/region-policy') ? json(policy) : undefined),
        ]);
        open(['outreach:write', 'workspace:admin']);
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for EU' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Allow outreach…' }));
        const dialog = await screen.findByRole('dialog');
        const confirm = within(dialog).getByRole('button', { name: 'Allow outreach' });
        expect(confirm).toBeDisabled();
        await userEvent.type(within(dialog).getByLabelText(/Lawful basis/), 'Legitimate interest assessment LIA-7');
        await userEvent.click(confirm);
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({
                region: 'eu',
                allowed: true,
                lawfulBasis: 'Legitimate interest assessment LIA-7',
            }),
        );
    });

    it('blocks an allowed region after confirming, with no lawful basis asked', async () => {
        const seen = stubApi([
            listed,
            (r) => (r.method === 'PUT' && r.url.endsWith('/outreach/region-policy') ? json(policy) : undefined),
        ]);
        open(['outreach:write', 'workspace:admin']);
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for US' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Block outreach…' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).queryByLabelText(/Lawful basis/)).toBeNull();
        await userEvent.click(within(dialog).getByRole('button', { name: 'Block outreach' }));
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({ region: 'us', allowed: false }),
        );
    });
});
