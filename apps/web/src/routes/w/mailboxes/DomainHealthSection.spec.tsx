import type { Capability } from '@bylinecrm/shared';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendingDomainView } from '../../../api/types';
import { json, renderAt, route, stubApi } from '../settings/settingsTestKit';
import { DomainHealthSection } from './DomainHealthSection';

const WS = 'ws-1';

const domain = (over: Partial<SendingDomainView> = {}): SendingDomainView => ({
    id: 'd-1',
    domain: 'out.example',
    dkimSelector: 'google',
    status: 'pass',
    lastCheck: {
        spf: { outcome: 'pass', message: 'SPF includes _spf.google.com' },
        dkim: { outcome: 'pass', message: 'DKIM key found' },
        dmarc: { outcome: 'pass', message: 'DMARC policy none' },
    },
    checkedAt: '2026-10-17T08:00:00.000Z',
    nextCheckAt: '2026-10-17T14:00:00.000Z',
    usedBy: ['pool'],
    gated: true,
    inPostmaster: true,
    spamRate: null,
    spamRates: [],
    deliveryErrorRate: null,
    deliveryErrorRates: [],
    postmaster: {
        status: 'ok',
        message: null,
        readAt: '2026-10-17T06:00:00.000Z',
        nextReadAt: '2026-10-18T00:00:00.000Z',
    },
    ...over,
});

const POOL = domain();
const PERSONAL = domain({
    id: 'd-2',
    domain: 'pinionpartners.co',
    status: 'fail',
    lastCheck: {
        spf: { outcome: 'pass', message: 'SPF includes _spf.google.com' },
        dkim: { outcome: 'fail', message: 'no DKIM key at google._domainkey.pinionpartners.co' },
        dmarc: { outcome: 'pass', message: 'DMARC policy none' },
    },
    usedBy: ['personal'],
    gated: false,
    spamRate: { day: '2026-10-17', rateBps: 12 },
    spamRates: [
        { day: '2026-10-15', rateBps: 4 },
        { day: '2026-10-16', rateBps: 8 },
        { day: '2026-10-17', rateBps: 12 },
    ],
    deliveryErrorRate: { day: '2026-10-17', rateBps: 210 },
    deliveryErrorRates: [{ day: '2026-10-17', rateBps: 210 }],
});
const LISTED = domain({
    id: 'd-3',
    domain: 'news.example',
    usedBy: [],
    gated: false,
    postmaster: {
        status: 'ok',
        message: 'no data for 2026-10-17: too little Gmail-bound traffic to report',
        readAt: '2026-10-17T06:00:00.000Z',
        nextReadAt: '2026-10-18T00:00:00.000Z',
    },
});
const SPENT = domain({
    id: 'd-4',
    domain: 'pinionnewswire.com',
    spamRate: { day: '2026-10-13', rateBps: 3 },
    spamRates: [{ day: '2026-10-13', rateBps: 3 }],
    postmaster: {
        status: 'quota_exhausted',
        message:
            "Google’s Postmaster Tools API quota is used up (RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Queries' and limit 'Queries per day'): raise the Postmaster Tools API quota in Google Cloud",
        readAt: '2026-10-17T06:00:00.000Z',
        nextReadAt: '2026-10-17T12:00:00.000Z',
    },
});

const OUTREACH: Capability[] = ['mailbox:read', 'outreach:write', 'record:read'];
const ADMIN: Capability[] = [...OUTREACH, 'workspace:admin'];

const section = (capabilities: Capability[]) =>
    renderAt(
        [route('/w/:workspaceId/mailboxes', <DomainHealthSection workspaceId={WS} />)],
        `/w/${WS}/mailboxes`,
        capabilities,
    );
const answer = (domains: SendingDomainView[]) =>
    stubApi([(r) => (r.url.endsWith('/sending-domains') ? json(domains) : undefined)]);
const row = async (name: string) => (await screen.findAllByText(name))[0]!.closest('tr')!;

describe('#190 FR-CRMS-13: domain health for every sending domain', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('shows every domain — pool, personal and Postmaster’s own — with its use, checks, spam rate and reads', async () => {
        answer([POOL, PERSONAL, LISTED]);
        section(OUTREACH);
        expect(await screen.findByRole('heading', { name: 'Domain health' })).toBeInTheDocument();

        const pool = await row('out.example');
        expect(within(pool).getByText('Pool — gated')).toBeInTheDocument();

        const personal = await row('pinionpartners.co');
        expect(within(personal).getByText('Personal — monitored')).toBeInTheDocument();
        expect(
            within(personal).getByText('DKIM: no DKIM key at google._domainkey.pinionpartners.co'),
        ).toBeInTheDocument();
        expect(within(personal).getByText(/0\.12% on 2026-10-17/)).toBeInTheDocument();
        expect(
            within(personal).getByRole('img', { name: /Spam rate, last 30 days: 0\.04% to 0\.12%/ }),
        ).toBeInTheDocument();
        expect(within(personal).getByText(/Read .*next read/)).toBeInTheDocument();
        // Delivery errors are shown beside the spam rate, for watching only.
        expect(within(personal).getByText('Delivery errors 2.10% on 2026-10-17')).toBeInTheDocument();

        const listed = await row('news.example');
        expect(within(listed).getByText('In Postmaster Tools only')).toBeInTheDocument();
        expect(within(listed).getByText(/too little Gmail-bound traffic/)).toBeInTheDocument();

        // "No data" is explained, never shown as a zero, and the gate's split is said once.
        expect(screen.getByText(/only for domains with substantial Gmail-bound traffic/)).toBeInTheDocument();
        expect(screen.getByText(/personal domains are monitored, never blocked/i)).toBeInTheDocument();
        expect(screen.queryByText('0%')).not.toBeInTheDocument();
    });

    it('tells an admin to raise the Postmaster Tools API quota when Google says it is spent, with Google’s reason', async () => {
        answer([POOL, SPENT]);
        section(ADMIN);
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(/Raise the Postmaster Tools API quota in Google Cloud/);
        expect(alert).toHaveTextContent(/Queries per day/);
        expect(within(alert).getByRole('link', { name: /Google Cloud quotas/ })).toHaveAttribute(
            'href',
            expect.stringContaining('gmailpostmastertools.googleapis.com/quotas'),
        );
    });

    it('tells a member the quota is an admin’s to raise', async () => {
        answer([SPENT]);
        section(OUTREACH);
        expect(await screen.findByRole('alert')).toHaveTextContent(/an admin needs to raise/i);
    });

    it('links each domain to its page for an admin, and not for a member', async () => {
        answer([PERSONAL]);
        const { unmount } = section(ADMIN);
        expect(await screen.findByRole('link', { name: 'pinionpartners.co' })).toHaveAttribute(
            'href',
            `/w/${WS}/mailboxes/domains/d-2`,
        );
        unmount();
        answer([PERSONAL]);
        section(OUTREACH);
        await row('pinionpartners.co');
        expect(screen.queryByRole('link', { name: 'pinionpartners.co' })).not.toBeInTheDocument();
    });

    it('says so when no mailbox is connected and no Postmaster account lists a domain', async () => {
        answer([]);
        section(OUTREACH);
        expect(await screen.findByText('No sending domain yet')).toBeInTheDocument();
    });

    it('is not drawn for someone who does not run outreach, and asks for nothing', () => {
        const seen = stubApi([]);
        section(['mailbox:read', 'record:read']);
        expect(screen.queryByRole('heading', { name: 'Domain health' })).not.toBeInTheDocument();
        expect(seen).toHaveLength(0);
    });
});
