import type { Capability } from '@bylinecrm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSend } from '../../../api/mail';
import { createQueryClient, keys } from '../../../api/queries';
import type { MailOutboundView, TimelineActivityView } from '../../../api/types';
import { TimelinePanel } from '../records/TimelinePanel';
import { json, renderAt, route, stubApi, type FakeRoute } from '../settings/settingsTestKit';
import { PERSON, WS, isRecordSends, outbound, quietRecordRoutes, recordSendsRoute } from './mailTestKit';

const CAN_SEND: Capability[] = ['email:send', 'mailbox:read', 'record:read'];
const READ_ONLY: Capability[] = ['record:read'];
const target = { type: 'person' as const, id: PERSON.id };

const session = (id: string): SessionSend => ({
    messageId: id,
    personId: PERSON.id,
    dealId: null,
    subject: 'Hello',
    input: { mailboxId: 'mb-1', personId: PERSON.id, subject: 'Hello', body: { type: 'doc', content: [] } },
    accepted: { messageId: id, status: 'queued', sendAt: null, senderTimeZone: null, recipientTimeZone: null },
});

/** Answers `GET /mail/messages/:id` with each view in turn, then the last one for good. */
function statusRoute(id: string, views: MailOutboundView[]): FakeRoute {
    let read = 0;
    return (r) => {
        if (r.method !== 'GET' || !r.url.endsWith(`/mail/messages/${id}`)) return undefined;
        const view = views[Math.min(read, views.length - 1)];
        read += 1;
        return json(view);
    };
}

function timeline(routes: FakeRoute[], sends: SessionSend[] = []) {
    const seen = stubApi([...routes, recordSendsRoute(), ...quietRecordRoutes]);
    const client = createQueryClient();
    client.setQueryData(keys.mailSession(WS), sends);
    renderAt(
        [route('/w/:workspaceId/people/:id', <TimelinePanel workspaceId={WS} target={target} />)],
        `/w/${WS}/people/${PERSON.id}`,
        CAN_SEND,
        client,
    );
    return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('FR-CRMS-UI-2: a send shows on the timeline at once and follows its status', () => {
    it('reads “Sending…”, then “Sent” once a poll says so', async () => {
        timeline(
            [
                statusRoute('out-1', [
                    outbound({ status: 'sending' }),
                    outbound({ status: 'sent', sentAt: '2026-10-09T08:01:00.000Z' }),
                ]),
            ],
            [session('out-1')],
        );
        expect(await screen.findByText('emailed “Hello”')).toBeInTheDocument();
        expect(screen.getByText('Sending…')).toBeInTheDocument();
        expect(await screen.findByText('Sent', {}, { timeout: 4_000 })).toBeInTheDocument();
    });

    it('reads a subject the server has not built yet with its variables as names', async () => {
        timeline(
            [statusRoute('out-1', [outbound({ status: 'sending', subject: '' })])],
            [{ ...session('out-1'), subject: 'About {{company.name}}' }],
        );
        expect(await screen.findByText('emailed “About company.name”')).toBeInTheDocument();
    });

    it('#134 shows a failure’s reason, and Retry asks the server to send it again', async () => {
        const seen = timeline(
            [
                statusRoute('out-1', [
                    outbound({
                        status: 'failed',
                        canRetry: true,
                        error: {
                            code: 'gmail.rejected',
                            message: 'Gmail refused the message.',
                            at: '2026-10-09T08:01:00.000Z',
                        },
                    }),
                ]),
                (r) =>
                    r.method === 'POST' && r.url.endsWith('/mail/messages/out-1/retry')
                        ? json(outbound({ status: 'scheduled', sendAt: new Date().toISOString(), canRetry: false }))
                        : undefined,
            ],
            [session('out-1')],
        );
        expect(await screen.findByText('Failed')).toBeInTheDocument();
        expect(screen.getByText('Gmail refused the message.')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(screen.queryByText('Failed')).not.toBeInTheDocument());
        expect(seen.some((r) => r.method === 'POST' && r.url.endsWith('/mail/messages/out-1/retry'))).toBe(true);
        expect(seen.some((r) => r.url.endsWith('/mail/send'))).toBe(false);
    });

    it('names the variables a scheduled send found empty at its time', async () => {
        timeline(
            [
                statusRoute('out-1', [
                    outbound({
                        status: 'failed',
                        error: {
                            code: 'unsendable',
                            message: 'x',
                            at: '2026-10-09T08:01:00.000Z',
                            fields: ['custom.lastOutlet'],
                        },
                    }),
                ]),
            ],
            [session('out-1')],
        );
        expect(
            await screen.findByText('custom.lastOutlet had no value when it was due; it was not sent.'),
        ).toBeInTheDocument();
    });
});

describe('FR-CRMS-UI-2 / P2-5: a scheduled send on the timeline', () => {
    const scheduled = outbound({
        id: 'out-9',
        status: 'scheduled',
        subject: 'Next week',
        sendAt: '2026-12-01T09:00:00.000Z',
        senderTimeZone: 'Europe/London',
    });

    it('says when it goes, in the zone it was scheduled in, and can be called off', async () => {
        const seen = stubApi([
            recordSendsRoute([scheduled]),
            statusRoute('out-9', [scheduled]),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/mail/messages/out-9/cancel')
                    ? json({ ...scheduled, status: 'cancelled', cancelledAt: '2026-10-09T09:00:00.000Z' })
                    : undefined,
            ...quietRecordRoutes,
        ]);
        renderAt(
            [route('/w/:workspaceId/people/:id', <TimelinePanel workspaceId={WS} target={target} />)],
            `/w/${WS}/people/${PERSON.id}`,
            CAN_SEND,
        );
        expect(await screen.findByText(/^Scheduled for .*\(Europe\/London\)$/)).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Cancel send' }));
        const dialog = await screen.findByRole('dialog', { name: 'Cancel this send?' });
        await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel send' }));
        await waitFor(() => expect(screen.queryByText(/^Scheduled for/)).not.toBeInTheDocument());
        expect(seen.some((r) => r.method === 'POST' && r.url.endsWith('/out-9/cancel'))).toBe(true);
    });

    it('moves to another time with the sender’s zone', async () => {
        const seen = stubApi([
            recordSendsRoute([scheduled]),
            statusRoute('out-9', [scheduled]),
            (r) =>
                r.method === 'PATCH' && r.url.endsWith('/mail/messages/out-9')
                    ? json({ ...scheduled, sendAt: '2026-12-02T09:00:00.000Z' })
                    : undefined,
            ...quietRecordRoutes,
        ]);
        renderAt(
            [route('/w/:workspaceId/people/:id', <TimelinePanel workspaceId={WS} target={target} />)],
            `/w/${WS}/people/${PERSON.id}`,
            CAN_SEND,
        );
        await userEvent.click(await screen.findByRole('button', { name: 'Reschedule' }));
        const panel = await screen.findByRole('dialog', { name: 'Reschedule send' });
        await userEvent.click(within(panel).getByRole('button', { name: 'Reschedule' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'PATCH')).toBe(true));
        const body = seen.find((r) => r.method === 'PATCH')?.body as Record<string, unknown>;
        expect(body['sendAt']).toBe('2026-12-01T09:00:00.000Z');
        expect(body['timeZone']).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });
});

describe('#104: a record’s sends come from the server, a page at a time', () => {
    const failed = outbound({
        id: 'out-7',
        status: 'failed',
        subject: 'Sent last week',
        error: { code: 'recipient.suppressed', message: 'dana@acme.com unsubscribed.', at: '2026-10-09T08:01:00.000Z' },
    });

    it('asks for this record’s failed and scheduled sends', async () => {
        const seen = timeline([]);
        await waitFor(() => expect(seen.some(isRecordSends)).toBe(true));
        const url = new URL(seen.find(isRecordSends)!.url, 'http://x');
        expect(url.searchParams.get('target')).toBe(`person:${PERSON.id}`);
        expect(url.searchParams.get('status')).toBe('failed,scheduled');
    });

    it('#134 shows a failed send after a reload with its reason, and no Retry when the server says it cannot be retried', async () => {
        stubApi([recordSendsRoute([failed]), statusRoute('out-7', [failed]), ...quietRecordRoutes]);
        renderAt(
            [route('/w/:workspaceId/people/:id', <TimelinePanel workspaceId={WS} target={target} />)],
            `/w/${WS}/people/${PERSON.id}`,
            CAN_SEND,
        );
        expect(await screen.findByText('emailed “Sent last week”')).toBeInTheDocument();
        expect(screen.getByText('Failed')).toBeInTheDocument();
        expect(screen.getByText('dana@acme.com unsubscribed.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    });

    it('#134 a failed send loaded after a reload offers Retry when the server says it can', async () => {
        const retryable = outbound({ ...failed, id: 'out-8', subject: 'Kept to retry', canRetry: true });
        stubApi([recordSendsRoute([retryable]), statusRoute('out-8', [retryable]), ...quietRecordRoutes]);
        renderAt(
            [route('/w/:workspaceId/people/:id', <TimelinePanel workspaceId={WS} target={target} />)],
            `/w/${WS}/people/${PERSON.id}`,
            CAN_SEND,
        );
        expect(await screen.findByText('emailed “Kept to retry”')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('names a colleague’s send by its sender and dates it when it was made', async () => {
        const theirs = outbound({
            ...failed,
            id: 'out-6',
            subject: 'From a colleague',
            senderMemberId: 'm-2',
            createdAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
        });
        stubApi([
            recordSendsRoute([theirs]),
            statusRoute('out-6', [theirs]),
            (r) =>
                r.url.endsWith('/members/summary')
                    ? json([
                          { memberId: 'm-1', name: 'Kate Morgan' },
                          { memberId: 'm-2', name: 'Sam Lee' },
                      ])
                    : undefined,
            ...quietRecordRoutes,
        ]);
        renderAt(
            [route('/w/:workspaceId/people/:id', <TimelinePanel workspaceId={WS} target={target} />)],
            `/w/${WS}/people/${PERSON.id}`,
            CAN_SEND,
        );
        expect(await screen.findByText('emailed “From a colleague”')).toBeInTheDocument();
        expect(await screen.findByText('Sam Lee')).toBeInTheDocument();
        expect(screen.getByText('3 hours ago')).toBeInTheDocument();
    });

    it('lists a company’s sends too', async () => {
        const company = { type: 'company' as const, id: '0b1e0000-0000-4000-8000-0000000000c1' };
        const seen = stubApi([recordSendsRoute([failed]), statusRoute('out-7', [failed]), ...quietRecordRoutes]);
        renderAt(
            [route('/w/:workspaceId/companies/:id', <TimelinePanel workspaceId={WS} target={company} />)],
            `/w/${WS}/companies/${company.id}`,
            CAN_SEND,
        );
        expect(await screen.findByText('emailed “Sent last week”')).toBeInTheDocument();
        const url = new URL(seen.find(isRecordSends)!.url, 'http://x');
        expect(url.searchParams.get('target')).toBe(`company:${company.id}`);
    });

    it('offers “Show more sends” while the API has a next page, and reads it with the cursor', async () => {
        const later = outbound({
            id: 'out-8',
            status: 'scheduled',
            subject: 'Far ahead',
            sendAt: '2026-12-20T09:00:00.000Z',
            senderTimeZone: 'Europe/London',
        });
        const seen = stubApi([
            (r) =>
                isRecordSends(r)
                    ? r.url.includes('cursor=c2')
                        ? json({ items: [later], nextCursor: null })
                        : json({ items: [failed], nextCursor: 'c2' })
                    : undefined,
            statusRoute('out-7', [failed]),
            statusRoute('out-8', [later]),
            ...quietRecordRoutes,
        ]);
        renderAt(
            [route('/w/:workspaceId/people/:id', <TimelinePanel workspaceId={WS} target={target} />)],
            `/w/${WS}/people/${PERSON.id}`,
            CAN_SEND,
        );
        await userEvent.click(await screen.findByRole('button', { name: 'Show more sends' }));
        expect(await screen.findByText('scheduled “Far ahead”')).toBeInTheDocument();
        expect(seen.some((r) => r.url.includes('cursor=c2'))).toBe(true);
        expect(screen.queryByRole('button', { name: 'Show more sends' })).not.toBeInTheDocument();
    });
});

describe('#133: a colleague’s send on a shared record is visible, and read-only', () => {
    const theirs = outbound({
        id: 'out-12',
        status: 'scheduled',
        subject: 'Their follow-up',
        sendAt: '2026-12-02T09:00:00.000Z',
        senderTimeZone: 'Europe/London',
        senderMemberId: 'm-2',
        canChange: false,
    });
    const names = (r: { url: string }) =>
        r.url.endsWith('/members/summary')
            ? json([
                  { memberId: 'm-1', name: 'Kate Morgan' },
                  { memberId: 'm-2', name: 'Sam Lee' },
              ])
            : undefined;

    it('shows when it goes and who sent it, without Reschedule or Cancel', async () => {
        stubApi([recordSendsRoute([theirs]), statusRoute('out-12', [theirs]), names, ...quietRecordRoutes]);
        renderAt(
            [route('/w/:workspaceId/people/:id', <TimelinePanel workspaceId={WS} target={target} />)],
            `/w/${WS}/people/${PERSON.id}`,
            CAN_SEND,
        );
        expect(await screen.findByText(/^Scheduled for .*\(Europe\/London\)$/)).toBeInTheDocument();
        expect(await screen.findByText('Sam Lee')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Reschedule' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Cancel send' })).not.toBeInTheDocument();
    });

    it('is shown to a reader who may not send mail', async () => {
        const seen = stubApi([
            recordSendsRoute([theirs]),
            statusRoute('out-12', [theirs]),
            names,
            ...quietRecordRoutes,
        ]);
        renderAt(
            [route('/w/:workspaceId/people/:id', <TimelinePanel workspaceId={WS} target={target} />)],
            `/w/${WS}/people/${PERSON.id}`,
            READ_ONLY,
        );
        expect(await screen.findByText('scheduled “Their follow-up”')).toBeInTheDocument();
        expect(seen.some(isRecordSends)).toBe(true);
    });
});

describe('FR-CRMS-4: stored mail on the timeline opens its thread', () => {
    const entry: TimelineActivityView = {
        id: 'tl-1',
        target,
        kind: 'linked-email.received',
        happenedAt: '2026-10-09T07:00:00.000Z',
        actor: { kind: 'sync', id: null },
        properties: {
            linked: { type: 'email', id: 'mm-1', name: 'Intro' },
            email: {
                direction: 'inbound',
                subject: 'Intro',
                snippet: 'Hi',
                from: 'dana@acme.com',
                threadId: 'th-1',
                mailboxId: 'mb-1',
            },
        },
        linked: { type: 'email', id: 'mm-1' },
        createdAt: '2026-10-09T07:00:00.000Z',
    };

    it('links the line to the thread view, and a sent message gives way to its stored copy', async () => {
        stubApi([
            statusRoute('out-1', [outbound({ status: 'sent', mailMessageId: 'mm-1', threadId: 'th-1' })]),
            (r) => (r.url.includes('/timeline') ? json({ items: [entry], nextCursor: null }) : undefined),
            recordSendsRoute(),
            ...quietRecordRoutes,
        ]);
        const client = createQueryClient();
        client.setQueryData(keys.mailSession(WS), [session('out-1')]);
        renderAt(
            [route('/w/:workspaceId/people/:id', <TimelinePanel workspaceId={WS} target={target} />)],
            `/w/${WS}/people/${PERSON.id}`,
            CAN_SEND,
            client,
        );
        const link = await screen.findByRole('link', { name: 'wrote “Intro”' });
        expect(link).toHaveAttribute('href', `/w/${WS}/people/${PERSON.id}?thread=th-1`);
        await waitFor(() => expect(screen.queryByText('emailed “Hello”')).not.toBeInTheDocument());
    });

    it('filters to emails with the Emails chip', async () => {
        const seen = timeline([]);
        await userEvent.click(await screen.findByRole('button', { name: 'Emails' }));
        await waitFor(() => expect(seen.some((r) => r.url.includes('kinds=linked-email'))).toBe(true));
    });
});
