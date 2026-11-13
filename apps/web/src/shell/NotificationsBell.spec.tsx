import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationSettingsView, NotificationsView } from '../api/types';
import { json, renderAt, route, stubApi } from '../routes/w/settings/settingsTestKit';
import { createQueryClient } from '../api/queries';
import { chime } from '../lib/chime';
import { NotificationsBell } from './NotificationsBell';

vi.mock('../lib/chime', () => ({ chime: vi.fn() }));
import { canOpenTransferRecord } from './NotificationsPanel';

const WS = 'ws-1';

const SETTINGS: NotificationSettingsView = {
    taskDigest: true,
    notifyEmailReplies: true,
    notifyEmailClicks: true,
    notifyEmailOpens: true,
    notifySound: true,
};

const NONE = { task: null, transfer: null, guardrail: null, invoice: null, cadence: null, payment: null } as const;

/** A reply, a click and an open of sends the member made. */
const ENGAGEMENT: NotificationsView = {
    unread: 3,
    items: [
        {
            ...NONE,
            id: 'e-1',
            kind: 'email_replied',
            target: { type: 'reply', id: 'm-1' },
            createdAt: '2026-11-06T09:00:00Z',
            readAt: null,
            email: {
                outboundId: null,
                messageId: 'm-1',
                subject: 'Re: Quick question',
                personId: 'p-1',
                personName: 'Pat Prospect',
                url: null,
            },
        },
        {
            ...NONE,
            id: 'e-2',
            kind: 'email_clicked',
            target: { type: 'email', id: 'o-1' },
            createdAt: '2026-11-06T08:00:00Z',
            readAt: null,
            email: {
                outboundId: 'o-1',
                messageId: null,
                subject: 'Pricing',
                personId: 'p-1',
                personName: 'Pat Prospect',
                url: 'https://example.test/pricing',
            },
        },
        {
            ...NONE,
            id: 'e-3',
            kind: 'email_opened',
            target: { type: 'email', id: 'o-1' },
            createdAt: '2026-11-06T07:00:00Z',
            readAt: null,
            email: {
                outboundId: 'o-1',
                messageId: null,
                subject: 'Pricing',
                personId: null,
                personName: null,
                url: null,
            },
        },
    ],
};

const INBOX: NotificationsView = {
    unread: 1,
    items: [
        {
            id: 'n-1',
            kind: 'task_assigned',
            target: { type: 'task', id: 't-1' },
            transfer: null,
            guardrail: null,
            invoice: null,
            cadence: null,
            payment: null,
            email: null,
            createdAt: '2026-10-18T09:00:00Z',
            readAt: null,
            task: {
                id: 't-1',
                title: 'Call if no reply',
                dueAt: '2026-10-18T09:00:00Z',
                targets: [{ type: 'person', id: 'p-1', label: 'Pat Prospect' }],
            },
        },
        {
            id: 'n-2',
            kind: 'task_due',
            target: { type: 'task', id: 't-2' },
            transfer: null,
            guardrail: null,
            invoice: null,
            cadence: null,
            payment: null,
            email: null,
            createdAt: '2026-10-17T09:00:00Z',
            readAt: '2026-10-17T10:00:00Z',
            task: {
                id: 't-2',
                title: 'Send the deck',
                dueAt: '2026-10-17T09:00:00Z',
                targets: [{ type: 'company', id: 'c-1', label: 'Acme' }],
            },
        },
    ],
};

const bell = () =>
    renderAt(
        [
            route('/w/:workspaceId/home', <NotificationsBell workspaceId={WS} />),
            route('/w/:workspaceId/people/:personId', <p>person page</p>),
        ],
        `/w/${WS}/home`,
        ['record:read'],
    );

describe('#192 the bell: a member’s task notifications', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('says how many are unread, lists them with what they are about, and opens the record, marking it read', async () => {
        const seen = stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/notifications') ? json(INBOX) : undefined),
            (r) => (r.method === 'GET' && r.url.endsWith('/notification-settings') ? json(SETTINGS) : undefined),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/notifications/read')
                    ? new Response(null, { status: 204 })
                    : undefined,
        ]);
        bell();
        await userEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
        const panel = await screen.findByRole('dialog', { name: 'Notifications' });
        expect(within(panel).getByText('Assigned to you')).toBeInTheDocument();
        expect(within(panel).getByText('Due')).toBeInTheDocument();
        await userEvent.click(within(panel).getByRole('link', { name: /Call if no reply.*Pat Prospect/ }));
        expect(await screen.findByText('person page')).toBeInTheDocument();
        await waitFor(() => expect(seen.find((r) => r.method === 'POST')?.body).toEqual({ ids: ['n-1'] }));
    });

    it('marks all read, and shows no unread count when there is none', async () => {
        const seen = stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/notifications') ? json(INBOX) : undefined),
            (r) => (r.method === 'GET' && r.url.endsWith('/notification-settings') ? json(SETTINGS) : undefined),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/notifications/read')
                    ? new Response(null, { status: 204 })
                    : undefined,
        ]);
        bell();
        await userEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
        await waitFor(() => expect(seen.find((r) => r.method === 'POST')?.body).toEqual({}));
    });

    it('turns the daily email digest off', async () => {
        const seen = stubApi([
            (r) =>
                r.method === 'GET' && r.url.endsWith('/notifications') ? json({ unread: 0, items: [] }) : undefined,
            (r) => (r.method === 'GET' && r.url.endsWith('/notification-settings') ? json(SETTINGS) : undefined),
            (r) =>
                r.method === 'PUT' && r.url.endsWith('/notification-settings')
                    ? json({ ...SETTINGS, taskDigest: false })
                    : undefined,
        ]);
        bell();
        await userEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
        expect(await screen.findByText('Nothing yet')).toBeInTheDocument();
        const digest = await screen.findByRole('switch', { name: /daily email of tasks due/i });
        expect(digest).toBeChecked();
        await userEvent.click(digest);
        await waitFor(() => expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({ taskDigest: false }));
    });

    it('shows replies, clicks and opens of my sends, each opening the person', async () => {
        const seen = stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/notifications') ? json(ENGAGEMENT) : undefined),
            (r) => (r.method === 'GET' && r.url.endsWith('/notification-settings') ? json(SETTINGS) : undefined),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/notifications/read')
                    ? new Response(null, { status: 204 })
                    : undefined,
        ]);
        bell();
        await userEvent.click(await screen.findByRole('button', { name: 'Notifications, 3 unread' }));
        const panel = await screen.findByRole('dialog', { name: 'Notifications' });
        expect(within(panel).getByRole('link', { name: /Pat Prospect clicked a link.*Pricing/ })).toBeInTheDocument();
        // An open of a send to no one in the CRM opens nothing.
        expect(within(panel).getByText('Someone opened your email')).toBeInTheDocument();
        expect(within(panel).queryByRole('link', { name: /Someone opened your email/ })).toBeNull();
        await userEvent.click(within(panel).getByRole('link', { name: /Reply from Pat Prospect.*Re: Quick question/ }));
        expect(await screen.findByText('person page')).toBeInTheDocument();
        await waitFor(() => expect(seen.find((r) => r.method === 'POST')?.body).toEqual({ ids: ['e-1'] }));
    });

    it('answers an offer in the panel: the receiver cannot open a record that is not theirs yet', async () => {
        const transfer = {
            id: 'tr-1',
            object: 'person',
            recordId: 'p-9',
            recordLabel: 'Pat Prospect',
            from: { memberId: 'm-2', name: 'Ana' },
            to: { memberId: 'm-1', name: 'Ben' },
            status: 'proposed',
            reason: null,
        } as const;
        const offered: NotificationsView = {
            unread: 1,
            items: [
                {
                    ...NONE,
                    email: null,
                    id: 'n-9',
                    kind: 'transfer_proposed',
                    target: { type: 'transfer', id: 'tr-1' },
                    createdAt: '2026-11-13T09:00:00Z',
                    readAt: null,
                    transfer,
                },
            ],
        };
        const seen = stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/notifications') ? json(offered) : undefined),
            (r) => (r.method === 'GET' && r.url.endsWith('/notification-settings') ? json(SETTINGS) : undefined),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/transfers/tr-1/accept')
                    ? json({ ...transfer, status: 'accepted' })
                    : undefined,
            (r) =>
                r.method === 'POST' && r.url.endsWith('/notifications/read')
                    ? new Response(null, { status: 204 })
                    : undefined,
        ]);
        bell();
        await userEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
        const panel = await screen.findByRole('dialog', { name: 'Notifications' });
        expect(within(panel).getByText('Ana offers you Pat Prospect')).toBeInTheDocument();
        // Waiting on them, it is answered here and is no link to a page they may not see.
        expect(within(panel).queryByRole('link', { name: /Pat Prospect/ })).toBeNull();
        expect(within(panel).getByRole('button', { name: 'Decline' })).toBeInTheDocument();
        await userEvent.click(within(panel).getByRole('button', { name: 'Accept' }));
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/transfers/tr-1/accept'))).toBe(true));
        await waitFor(() =>
            expect(seen.find((r) => r.url.endsWith('/notifications/read'))?.body).toEqual({ ids: ['n-9'] }),
        );

        // A member who keeps to their own records opens a transfer's record only while it is theirs.
        const own = { memberId: 'm-1', recordScope: 'own' } as const;
        expect(canOpenTransferRecord(transfer, own)).toBe(false);
        expect(canOpenTransferRecord({ ...transfer, status: 'accepted' }, own)).toBe(true);
        expect(canOpenTransferRecord({ ...transfer, status: 'accepted' }, { ...own, memberId: 'm-2' })).toBe(false);
        expect(canOpenTransferRecord({ ...transfer, status: 'declined' }, { ...own, memberId: 'm-2' })).toBe(true);
        expect(canOpenTransferRecord(transfer, { memberId: 'm-1', recordScope: 'all' })).toBe(true);
    });

    it('chimes and colours the bell when a notification arrives, not for what was already unread', async () => {
        let unread = 1;
        let sound = true;
        stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/notifications') ? json({ unread, items: [] }) : undefined),
            (r) =>
                r.method === 'GET' && r.url.endsWith('/notification-settings')
                    ? json({ ...SETTINGS, notifySound: sound })
                    : undefined,
        ]);
        const client = createQueryClient();
        renderAt([route('/w/:workspaceId/home', <NotificationsBell workspaceId={WS} />)], `/w/${WS}/home`, [], client);
        const button = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
        expect(button).toHaveClass('text-info');
        expect(chime).not.toHaveBeenCalled();
        unread = 2;
        await client.invalidateQueries();
        await screen.findByRole('button', { name: 'Notifications, 2 unread' });
        await waitFor(() => expect(chime).toHaveBeenCalledTimes(1));
        // Turned off, the bell still tells by its colour, silently.
        sound = false;
        unread = 3;
        await client.invalidateQueries();
        await screen.findByRole('button', { name: 'Notifications, 3 unread' });
        expect(chime).toHaveBeenCalledTimes(1);
    });

    it('turns email opens off, changing only that setting', async () => {
        const seen = stubApi([
            (r) =>
                r.method === 'GET' && r.url.endsWith('/notifications') ? json({ unread: 0, items: [] }) : undefined,
            (r) => (r.method === 'GET' && r.url.endsWith('/notification-settings') ? json(SETTINGS) : undefined),
            (r) =>
                r.method === 'PUT' && r.url.endsWith('/notification-settings')
                    ? json({ ...SETTINGS, notifyEmailOpens: false })
                    : undefined,
        ]);
        bell();
        await userEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
        expect(await screen.findByRole('switch', { name: /replies to emails i send/i })).toBeChecked();
        expect(screen.getByRole('switch', { name: /links clicked/i })).toBeChecked();
        const opens = screen.getByRole('switch', { name: /emails i send opened \(approximate/i });
        await userEvent.click(opens);
        await waitFor(() => expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({ notifyEmailOpens: false }));
        await waitFor(() => expect(opens).not.toBeChecked());
    });
});
