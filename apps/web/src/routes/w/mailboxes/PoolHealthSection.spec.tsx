import type { Capability } from '@bylinecrm/shared';
import { toasts } from '@bylinecrm/ui';
import { Toaster } from '@bylinecrm/ui/toaster';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolMailboxHealthView, SendingDomainView, SendingPoolView } from '../../../api/types';
import { json, renderAt, route, stubApi } from '../settings/settingsTestKit';
import { PoolHealthSection } from './PoolHealthSection';

const leaveFor = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/leaveFor', () => ({ leaveFor }));

const WS = 'ws-1';
const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y';

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
    checkedAt: '2026-10-12T08:00:00.000Z',
    nextCheckAt: '2026-10-12T14:00:00.000Z',
    usedBy: ['pool'],
    gated: true,
    inPostmaster: false,
    spamRate: null,
    spamRates: [],
    postmaster: { status: 'not_connected', message: null, readAt: null, nextReadAt: null },
    ...over,
});

const health = (over: Partial<PoolMailboxHealthView> = {}): PoolMailboxHealthView => ({
    mailboxId: 'mb-1',
    email: 'pool-a@out.example',
    status: 'connected',
    dailyCapOverride: null,
    dailyCap: 40,
    warmupDay: 11,
    warmupLimit: 22,
    allowance: 22,
    used: 7,
    paused: null,
    domain: domain(),
    canSend: true,
    ...over,
});

const PAUSED = health({
    mailboxId: 'mb-2',
    email: 'pool-b@out.example',
    paused: {
        code: 'bounce_rate',
        message: '3 hard bounces in 30 sends over 7 days (10%), at or above the 5% threshold',
        rateBps: 1000,
        thresholdBps: 500,
        sends: 30,
        at: '2026-10-12T09:00:00.000Z',
    },
    canSend: false,
});

const FAILING = health({
    mailboxId: 'mb-3',
    email: 'pool-c@bad.example',
    domain: domain({
        id: 'd-2',
        domain: 'bad.example',
        status: 'fail',
        lastCheck: {
            spf: { outcome: 'fail', message: 'the SPF record does not include _spf.google.com' },
            dkim: { outcome: 'pass', message: 'DKIM key found' },
            dmarc: { outcome: 'fail', message: 'no DMARC record at _dmarc.bad.example' },
        },
    }),
    canSend: false,
});

const VIEW: SendingPoolView = {
    settings: {
        dailyCap: 40,
        warmupStartPerDay: 5,
        warmupDays: 21,
        jitterMinSeconds: 60,
        jitterMaxSeconds: 300,
        bouncePauseBps: 500,
        complaintPauseBps: 20,
        rateMinSample: 20,
        rateWindowDays: 7,
    },
    mailboxes: [health(), PAUSED, FAILING],
    domains: [domain(), FAILING.domain!],
    postmaster: null,
};

/** Postmaster Tools connected (#129): one domain with yesterday's rate, one the account has not verified. */
const WITH_POSTMASTER: SendingPoolView = {
    ...VIEW,
    mailboxes: [
        health({
            domain: domain({
                spamRate: { day: '2026-10-11', rateBps: 35 },
                postmaster: {
                    status: 'ok',
                    message: null,
                    readAt: '2026-10-12T09:00:00.000Z',
                    nextReadAt: '2026-10-13T00:00:00.000Z',
                },
            }),
        }),
        health({
            mailboxId: 'mb-4',
            email: 'pool-d@other.example',
            domain: domain({
                id: 'd-3',
                domain: 'other.example',
                postmaster: {
                    status: 'not_verified',
                    message: 'other.example is not verified in Postmaster Tools for ops@acme.example',
                    readAt: '2026-10-12T09:00:00.000Z',
                    nextReadAt: '2026-10-12T15:00:00.000Z',
                },
            }),
        }),
        // #183: Google's quota said no this time; the last reading stands and the next try is scheduled.
        health({
            mailboxId: 'mb-5',
            email: 'pool-e@limited.example',
            domain: domain({
                id: 'd-4',
                domain: 'limited.example',
                spamRate: { day: '2026-10-10', rateBps: 12 },
                postmaster: {
                    status: 'rate_limited',
                    message: 'Postmaster Tools is rate-limiting reads',
                    readAt: '2026-10-12T09:00:00.000Z',
                    nextReadAt: '2026-10-12T15:00:00.000Z',
                },
            }),
        }),
    ],
    postmaster: {
        email: 'ops@acme.example',
        status: 'connected',
        connectedAt: '2026-10-10T09:00:00.000Z',
        lastError: null,
    },
};

const OUTREACH: Capability[] = ['mailbox:read', 'outreach:write', 'record:read'];
const ADMIN: Capability[] = [...OUTREACH, 'workspace:admin'];

const section = (capabilities: Capability[]) =>
    renderAt(
        [
            route(
                '/w/:workspaceId/mailboxes',
                <>
                    <PoolHealthSection workspaceId={WS} />
                    <Toaster />
                </>,
            ),
        ],
        `/w/${WS}/mailboxes`,
        capabilities,
    );

describe('FR-CRMS-6 / FR-CRMS-13: the sending pool’s health', () => {
    beforeEach(() => leaveFor.mockReset());
    afterEach(() => {
        vi.unstubAllGlobals();
        toasts.clear();
    });

    it('shows each pool mailbox’s allowance, warm-up day, domain checks and pause reason', async () => {
        stubApi([(r) => (r.url.endsWith('/sending-pool') ? json(VIEW) : undefined)]);
        section(OUTREACH);
        const row = async (email: string) => (await screen.findAllByText(email))[0]!.closest('tr')!;
        const first = await row('pool-a@out.example');
        expect(within(first).getByText('7 of 22')).toBeInTheDocument();
        expect(within(first).getByText('Warm-up day 11, cap 40')).toBeInTheDocument();
        expect(within(first).getByText('Sending')).toBeInTheDocument();

        const paused = await row('pool-b@out.example');
        expect(within(paused).getByText('Paused')).toBeInTheDocument();
        expect(within(paused).getByTestId('pause-reason')).toHaveTextContent(/3 hard bounces in 30 sends/);

        const failing = await row('pool-c@bad.example');
        expect(within(failing).getByText('Failing')).toBeInTheDocument();
        const checks = within(failing).getByRole('list', { name: 'bad.example failing checks' });
        expect(
            within(checks)
                .getAllByRole('listitem')
                .map((li) => li.textContent),
        ).toEqual([
            'SPF: the SPF record does not include _spf.google.com',
            'DMARC: no DMARC record at _dmarc.bad.example',
        ]);
        // A member who runs outreach reads it; changing it is an admin's.
        expect(screen.queryByRole('button', { name: 'Pool settings' })).not.toBeInTheDocument();
    });

    it('is not drawn for someone who does not run outreach, and asks for nothing', () => {
        const seen = stubApi([]);
        section(['mailbox:read', 'record:read']);
        expect(screen.queryByRole('heading', { name: 'Sending pool' })).not.toBeInTheDocument();
        expect(seen).toHaveLength(0);
    });

    it('resumes a paused mailbox only with a note, as an admin', async () => {
        const seen = stubApi([
            (r) =>
                r.method === 'POST' && r.url.endsWith('/mailboxes/mb-2/resume')
                    ? json({ ...PAUSED, paused: null, canSend: true })
                    : undefined,
            (r) => (r.url.endsWith('/sending-pool') ? json(VIEW) : undefined),
        ]);
        const user = userEvent.setup();
        section(ADMIN);
        const row = (await screen.findAllByText('pool-b@out.example'))[0]!.closest('tr')!;
        await user.click(within(row).getByRole('button', { name: 'Actions for pool-b@out.example' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Resume…' }));
        const dialog = await screen.findByRole('dialog', { name: 'Resume pool-b@out.example?' });
        const resume = within(dialog).getByRole('button', { name: 'Resume' });
        expect(resume).toBeDisabled();
        await user.type(within(dialog).getByLabelText(/What changed/), 'removed the bad list');
        await user.click(resume);
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'POST' && r.url.endsWith('/resume'))?.body).toEqual({
                note: 'removed the bad list',
            }),
        );
        expect(await screen.findByText('pool-b@out.example is sending again')).toBeInTheDocument();
    });

    it('saves the pool settings with rates entered in percent', async () => {
        const seen = stubApi([
            (r) => (r.method === 'PUT' && r.url.endsWith('/sending-pool/settings') ? json(VIEW.settings) : undefined),
            (r) => (r.url.endsWith('/sending-pool') ? json(VIEW) : undefined),
        ]);
        const user = userEvent.setup();
        section(ADMIN);
        await user.click(await screen.findByRole('button', { name: 'Pool settings' }));
        const dialog = await screen.findByRole('dialog', { name: 'Pool settings' });
        const bounce = within(dialog).getByLabelText(/Pause at bounce rate/);
        expect(bounce).toHaveValue(5);
        await user.clear(bounce);
        await user.type(bounce, '3');
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'PUT')?.body).toMatchObject({
                bouncePauseBps: 300,
                complaintPauseBps: 20,
            }),
        );
    });

    it('#129 shows each domain’s spam rate from Postmaster Tools, which account is connected, and lets an admin disconnect it', async () => {
        const seen = stubApi([
            (r) => (r.method === 'DELETE' && r.url.endsWith('/sending-pool/postmaster') ? json(null, 204) : undefined),
            (r) => (r.url.endsWith('/sending-pool') ? json(WITH_POSTMASTER) : undefined),
        ]);
        const user = userEvent.setup();
        section(ADMIN);
        const first = (await screen.findAllByText('pool-a@out.example'))[0]!.closest('tr')!;
        expect(within(first).getByText('Spam rate 0.35% on 2026-10-11')).toBeInTheDocument();
        const other = (await screen.findAllByText('pool-d@other.example'))[0]!.closest('tr')!;
        const warning = within(other).getByText(/not verified in Postmaster Tools for ops@acme\.example/);
        expect(warning).toHaveClass('text-warning');
        // #183: a rate limit is said calmly, with the next try, and the last reading stays shown.
        const limited = (await screen.findAllByText('pool-e@limited.example'))[0]!.closest('tr')!;
        expect(within(limited).getByText('Spam rate 0.12% on 2026-10-10')).toBeInTheDocument();
        const calm = within(limited).getByText(/Postmaster Tools is rate-limiting reads; next try/);
        expect(calm).toHaveClass('text-text-muted');
        expect(calm).not.toHaveClass('text-warning');

        const card = screen.getByRole('region', { name: 'Postmaster Tools' });
        expect(within(card).getByText('ops@acme.example')).toBeInTheDocument();
        await user.click(within(card).getByRole('button', { name: 'Disconnect' }));
        await user.click(await screen.findByRole('button', { name: 'Disconnect Postmaster Tools' }));
        await waitFor(() =>
            expect(seen.some((r) => r.method === 'DELETE' && r.url.endsWith('/sending-pool/postmaster'))).toBe(true),
        );
    });

    it('#129 sends an admin to Google to connect Postmaster Tools, and shows a member only that none is connected', async () => {
        const seen = stubApi([
            (r) =>
                r.method === 'POST' && r.url.endsWith('/sending-pool/postmaster/connect')
                    ? json({ authorizeUrl: AUTHORIZE, expiresAt: '2026-10-12T09:10:00.000Z' }, 201)
                    : undefined,
            (r) => (r.url.endsWith('/sending-pool') ? json(VIEW) : undefined),
        ]);
        const user = userEvent.setup();
        const view = section(ADMIN);
        const card = await screen.findByRole('region', { name: 'Postmaster Tools' });
        await user.click(within(card).getByRole('button', { name: 'Connect Postmaster Tools' }));
        await waitFor(() => expect(leaveFor).toHaveBeenCalledWith(AUTHORIZE));
        expect(seen.some((r) => r.method === 'POST' && r.url.endsWith('/sending-pool/postmaster/connect'))).toBe(true);
        view.unmount();

        section(OUTREACH);
        const read = await screen.findByRole('region', { name: 'Postmaster Tools' });
        expect(within(read).getByText(/Not connected/)).toBeInTheDocument();
        expect(within(read).queryByRole('button')).not.toBeInTheDocument();
    });
});
