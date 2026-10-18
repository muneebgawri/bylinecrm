import type { Capability } from '@bylinecrm/shared';
import { toasts } from '@bylinecrm/ui';
import { Toaster } from '@bylinecrm/ui/toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendingDomainView } from '../../../api/types';
import { json, renderAt, route, stubApi } from '../settings/settingsTestKit';
import { DomainPage } from './DomainPage';

const WS = 'ws-1';

const DOMAIN: SendingDomainView = {
    id: 'd-2',
    domain: 'pinionpartners.co',
    dkimSelector: 'google',
    status: 'fail',
    lastCheck: {
        spf: { outcome: 'pass', message: 'SPF includes _spf.google.com' },
        dkim: { outcome: 'fail', message: 'no DKIM key at google._domainkey.pinionpartners.co' },
        dmarc: { outcome: 'pass', message: 'DMARC policy none' },
    },
    checkedAt: '2026-10-17T08:00:00.000Z',
    nextCheckAt: '2026-10-17T14:00:00.000Z',
    usedBy: ['personal'],
    gated: false,
    inPostmaster: true,
    spamRate: { day: '2026-10-17', rateBps: 12 },
    spamRates: [
        { day: '2026-10-15', rateBps: 4 },
        { day: '2026-10-17', rateBps: 12 },
    ],
    deliveryErrorRate: { day: '2026-10-17', rateBps: 210 },
    deliveryErrorRates: [
        { day: '2026-10-14', rateBps: 40 },
        { day: '2026-10-17', rateBps: 210 },
    ],
    postmaster: {
        status: 'ok',
        message: null,
        readAt: '2026-10-17T06:00:00.000Z',
        nextReadAt: '2026-10-18T00:00:00.000Z',
    },
};

const ADMIN: Capability[] = ['mailbox:read', 'outreach:write', 'record:read', 'workspace:admin'];

const page = (capabilities: Capability[]) =>
    renderAt(
        [
            route(
                '/w/:workspaceId/mailboxes/domains/:domainId',
                <>
                    <DomainPage />
                    <Toaster />
                </>,
            ),
        ],
        `/w/${WS}/mailboxes/domains/d-2`,
        capabilities,
    );

describe('#190 FR-CRMS-13: one sending domain, for an admin', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        toasts.clear();
    });

    it('shows each check with its message, the 30 days Postmaster Tools reported, and what the gate does with it', async () => {
        stubApi([(r) => (r.url.endsWith('/sending-domains/d-2') ? json(DOMAIN) : undefined)]);
        page(ADMIN);
        expect(await screen.findByRole('heading', { level: 1, name: 'pinionpartners.co' })).toBeInTheDocument();
        expect(screen.getByText('no DKIM key at google._domainkey.pinionpartners.co')).toBeInTheDocument();
        expect(screen.getByText(/Monitored, never blocked/)).toBeInTheDocument();
        const days = screen.getByRole('table');
        expect(
            within(days)
                .getAllByRole('row')
                .slice(1)
                .map((r) => r.textContent),
        ).toEqual(['2026-10-170.12%2.10%', '2026-10-150.04%—', '2026-10-14—0.40%']);
    });

    it('checks the domain again on an admin’s word', async () => {
        const seen = stubApi([
            (r) => (r.url.endsWith('/sending-domains/d-2') ? json(DOMAIN) : undefined),
            (r) => (r.url.endsWith('/sending-domains/d-2/check') ? json({ ...DOMAIN, status: 'pass' }) : undefined),
        ]);
        page(ADMIN);
        await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'POST' && r.url.endsWith('/check'))).toBe(true));
        expect(await screen.findByText('pinionpartners.co is verified')).toBeInTheDocument();
    });

    it('is an admin’s page: anyone else is told so and nothing is asked', async () => {
        const seen = stubApi([]);
        page(['mailbox:read', 'outreach:write', 'record:read']);
        expect(await screen.findByText(/Only an admin can open a sending domain/)).toBeInTheDocument();
        expect(seen).toHaveLength(0);
    });
});
