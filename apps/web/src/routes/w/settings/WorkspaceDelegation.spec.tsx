import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DelegationMemberView, DelegationView } from '../../../api/types';
import { WorkspaceDelegation } from './WorkspaceDelegation';
import { json, renderAt, route, stubApi } from './settingsTestKit';

const WS = 'ws-1';
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
];

const view: DelegationView = {
    configured: true,
    clientEmail: 'sync@byline.iam.gserviceaccount.com',
    clientId: '104857600123456789012',
    privateKeyIdLast4: '9f3c',
    allowedDomains: ['pinionpartners.co', 'pinionnewswire.com'],
    scopes: SCOPES,
    grantedScopes: SCOPES.slice(1),
    active: true,
    lastCheck: {
        checkedAt: '2026-10-20T09:00:00.000Z',
        subject: 'matt@pinionpartners.co',
        scopes: [
            { scope: SCOPES[0]!, granted: false, error: 'unauthorized_client' },
            { scope: SCOPES[1]!, granted: true, error: null },
            { scope: SCOPES[2]!, granted: true, error: null },
        ],
    },
    delegatedMailboxes: 25,
    updatedAt: '2026-10-20T09:00:00.000Z',
};

const members: DelegationMemberView[] = [
    {
        memberId: 'm-2',
        name: 'Sam Okafor',
        email: 'sam@pinionpartners.co',
        state: 'delegated',
        excluded: false,
        mailboxId: 'mb-2',
        mailboxStatus: 'connected',
    },
];

const page = () =>
    renderAt(
        [route('/w/:workspaceId/settings/google', <WorkspaceDelegation workspaceId={WS} />)],
        `/w/${WS}/settings/google`,
        ['workspace:admin', 'mailbox:read'],
    );

const reads = (r: { url: string; method: string }) => {
    if (r.method !== 'GET') return undefined;
    if (r.url.endsWith('/mail/google-workspace')) return json(view);
    if (r.url.endsWith('/mail/google-workspace/members')) return json(members);
    if (r.url.endsWith('/mail/google-workspace/audit')) return json([]);
    return undefined;
};

describe('#225: Google Workspace delegation, set up by an admin', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('lists the exact scopes with a copy button and says a reseller or super admin adds the entry', async () => {
        stubApi([reads]);
        page();
        const list = await screen.findByRole('list', { name: 'Scopes to authorise' });
        for (const scope of SCOPES) expect(within(list).getByText(scope)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Copy scopes' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Copy client ID' })).toBeInTheDocument();
        expect(screen.getByText(/a super admin or your reseller adds this/)).toBeInTheDocument();
    });

    it('reports a scope the check found missing', async () => {
        stubApi([reads]);
        page();
        const results = await screen.findByRole('list', { name: 'Check results' });
        expect(within(results).getByText('Missing (unauthorized_client)')).toBeInTheDocument();
        expect(within(results).getAllByText('Authorised')).toHaveLength(2);
        expect(screen.getByText(/1 of 3 scopes missing/)).toBeInTheDocument();
    });

    it('excludes a member with the per-member toggle', async () => {
        const seen = stubApi([
            (r) => (r.method === 'PUT' ? json({ ...members[0]!, excluded: true, state: 'excluded' }) : undefined),
            reads,
        ]);
        page();
        await userEvent.click(
            await screen.findByRole('switch', { name: 'Sync sam@pinionpartners.co through delegation' }),
        );
        await waitFor(() => expect(seen.some((r) => r.method === 'PUT')).toBe(true));
        const put = seen.find((r) => r.method === 'PUT')!;
        expect(put.url).toMatch(/\/mail\/google-workspace\/members\/m-2$/);
        expect(put.body).toEqual({ excluded: true });
    });

    it('never shows the key, only the account and the key ID’s last four', async () => {
        stubApi([reads]);
        page();
        expect(await screen.findByText('•••• 9f3c')).toBeInTheDocument();
        expect(document.body.textContent).not.toContain('PRIVATE KEY');
    });
});
