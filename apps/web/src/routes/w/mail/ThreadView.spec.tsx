import type { Capability } from '@bylinecrm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, renderAt, route, stubApi, type FakeRoute } from '../settings/settingsTestKit';
import { PERSON, WS, draftsRoute, mailDraft, mailbox, mailboxesRoute, message, thread } from './mailTestKit';
import { BODY_HIDDEN, ThreadView } from './ThreadView';

const CAN_SEND: Capability[] = ['email:send', 'mailbox:read', 'record:read'];

const personRoute: FakeRoute = (r) =>
    r.method === 'GET' && r.url.endsWith(`/people/${PERSON.id}`)
        ? json({
              id: PERSON.id,
              nameFirst: 'Dana',
              nameLast: 'Reyes',
              emails: { primary: PERSON.email, additional: [] },
          })
        : undefined;

function view(routes: FakeRoute[]) {
    const seen = stubApi(routes);
    renderAt(
        [route('/w/:workspaceId/people/:id', <ThreadView workspaceId={WS} threadId="th-1" />)],
        `/w/${WS}/people/${PERSON.id}?thread=th-1`,
        CAN_SEND,
    );
    return seen;
}

const threadRoute =
    (body: ReturnType<typeof thread>): FakeRoute =>
    (r) =>
        r.method === 'GET' && r.url.endsWith('/mail/threads/th-1') ? json(body) : undefined;

afterEach(() => vi.unstubAllGlobals());

/** An email the member sent to the person from the CRM. */
const sentEmail = (over: Parameters<typeof message>[0] = {}) =>
    message({
        direction: 'outbound',
        sentByCrm: true,
        from: 'kate@example.com',
        participants: [
            { role: 'from', address: 'kate@example.com', displayName: 'Kate Morgan', personId: null, memberId: 'm-1' },
            { role: 'to', address: PERSON.email, displayName: PERSON.name, personId: PERSON.id, memberId: null },
        ],
        ...over,
    });

describe('FR-CRMS-4: the thread view', () => {
    it('runs oldest to newest and frames a sanitised body in a sandbox that allows no script', async () => {
        view([
            threadRoute(
                thread({
                    messageCount: 2,
                    messages: [
                        message({ id: 'msg-2', sentAt: '2026-10-09T09:00:00.000Z', bodyHtml: '<p>Second</p>' }),
                        message({ id: 'msg-1', sentAt: '2026-10-08T09:00:00.000Z', bodyHtml: '<p>First</p>' }),
                    ],
                }),
            ),
        ]);
        const list = await screen.findByRole('list', { name: 'Messages, oldest first' });
        const frames = within(list).getAllByTitle(/^Message from/) as HTMLIFrameElement[];
        expect(frames).toHaveLength(2);
        await waitFor(() => expect(frames[0]?.getAttribute('srcdoc')).toContain('<p>First</p>'));
        expect(frames[1]?.getAttribute('srcdoc')).toContain('<p>Second</p>');
        for (const frame of frames) {
            expect(frame.hasAttribute('sandbox')).toBe(true);
            expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
        }
        expect(frames[0]?.getAttribute('srcdoc')).toContain("default-src 'none'");
    });

    it('shows a message in another member’s personal mailbox as subject and participants only', async () => {
        view([
            threadRoute(
                thread({
                    bodiesVisible: false,
                    messages: [message({ subject: 'Pricing', bodiesVisible: false, bodyHtml: null, bodyText: null })],
                }),
            ),
        ]);
        expect(await screen.findByText(BODY_HIDDEN)).toBeInTheDocument();
        expect(screen.getByText('Pricing')).toBeInTheDocument();
        expect(screen.getByText('To Kate Morgan <kate@example.com>')).toBeInTheDocument();
        expect(screen.queryByTitle(/^Message from/)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();
    });

    it('replies to the newest message from the thread’s mailbox, with replyToMessageId', async () => {
        const seen = view([
            threadRoute(thread()),
            personRoute,
            mailboxesRoute([mailbox()]),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/mail/send')
                    ? json(
                          {
                              messageId: 'out-1',
                              status: 'queued',
                              sendAt: null,
                              senderTimeZone: null,
                              recipientTimeZone: null,
                              followUps: [],
                          },
                          202,
                      )
                    : undefined,
        ]);
        await userEvent.click(await screen.findByRole('button', { name: 'Reply' }));
        await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), 'Thanks');
        await userEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/mail/send'))).toBe(true));
        expect(seen.find((r) => r.url.endsWith('/mail/send'))?.body).toMatchObject({
            mailboxId: 'mb-1',
            personId: PERSON.id,
            replyToMessageId: 'msg-1',
        });
    });

    it('#350: schedules a follow-up on an email the CRM sent, three days on, unless they answer', async () => {
        const sent = sentEmail();
        const seen = view([
            threadRoute(thread({ messages: [sent] })),
            personRoute,
            mailboxesRoute([mailbox()]),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/mail/send')
                    ? json(
                          {
                              messageId: 'out-2',
                              status: 'scheduled',
                              sendAt: '2026-12-01T09:00:00.000Z',
                              senderTimeZone: null,
                              recipientTimeZone: null,
                              followUps: [],
                          },
                          202,
                      )
                    : undefined,
        ]);
        await userEvent.click(await screen.findByRole('button', { name: 'Schedule follow-up' }));
        expect(await screen.findByText(/unless they answer first/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
        await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), 'Any thoughts?');
        await userEvent.click(screen.getByRole('button', { name: 'Schedule follow-up' }));
        const panel = await screen.findByRole('dialog', { name: 'Schedule follow-up' });
        await userEvent.click(within(panel).getByRole('button', { name: 'Schedule follow-up' }));
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/mail/send'))).toBe(true));
        const body = seen.find((r) => r.url.endsWith('/mail/send'))?.body as { sendAt: string };
        expect(body).toMatchObject({ replyToMessageId: 'msg-1', followUp: true, personId: PERSON.id });
        // Three days on, as a new follow-up row starts.
        expect(Date.parse(body.sendAt) - Date.now()).toBeGreaterThan(2.9 * 24 * 60 * 60 * 1000);
    });

    it('#350: no follow-up on mail the CRM did not send, nor once they have answered', async () => {
        view([threadRoute(thread({ messages: [sentEmail({ sentByCrm: false })] }))]);
        expect(await screen.findByRole('button', { name: 'Reply' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Schedule follow-up' })).not.toBeInTheDocument();
    });

    it('#350: no follow-up once they have answered: the newest message is theirs', async () => {
        view([
            threadRoute(
                thread({
                    messages: [
                        sentEmail({ sentAt: '2026-10-08T09:00:00.000Z' }),
                        message({ id: 'msg-2', sentAt: '2026-10-09T09:00:00.000Z' }),
                    ],
                }),
            ),
        ]);
        expect(await screen.findByRole('button', { name: 'Reply' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Schedule follow-up' })).not.toBeInTheDocument();
    });

    it('a reply drafted in this thread: “Continue reply” opens it, and sending names the draft', async () => {
        const drafted = mailDraft({
            replyToMessageId: 'msg-0',
            threadId: 'th-1',
            content: {
                mailboxId: 'mb-1',
                body: {
                    type: 'doc',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Half a reply' }] }],
                },
            },
        });
        const seen = view([
            threadRoute(thread()),
            personRoute,
            mailboxesRoute([mailbox()]),
            draftsRoute([drafted, mailDraft({ id: 'new-email', content: { subject: 'Not this one' } })]),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/mail/send')
                    ? json(
                          {
                              messageId: 'out-1',
                              status: 'queued',
                              sendAt: null,
                              senderTimeZone: null,
                              recipientTimeZone: null,
                              followUps: [],
                          },
                          202,
                      )
                    : undefined,
        ]);
        await userEvent.click(await screen.findByRole('button', { name: 'Continue reply' }));
        expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveTextContent('Half a reply');
        await userEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/mail/send'))).toBe(true));
        expect(seen.find((r) => r.url.endsWith('/mail/send'))?.body).toMatchObject({
            replyToMessageId: 'msg-1',
            draftId: drafted.id,
        });
    });

    it('saves a new reply as a draft against the message it answers', async () => {
        const seen = view([
            threadRoute(thread()),
            personRoute,
            mailboxesRoute([mailbox()]),
            draftsRoute(),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/mail/drafts')
                    ? json(mailDraft({ replyToMessageId: 'msg-1', threadId: 'th-1' }), 201)
                    : undefined,
        ]);
        await userEvent.click(await screen.findByRole('button', { name: 'Reply' }));
        await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), 'Thanks');
        await waitFor(
            () => expect(seen.some((r) => r.method === 'POST' && r.url.endsWith('/mail/drafts'))).toBe(true),
            {
                timeout: 6_000,
            },
        );
        expect(seen.find((r) => r.method === 'POST' && r.url.endsWith('/mail/drafts'))?.body).toMatchObject({
            personId: PERSON.id,
            replyToMessageId: 'msg-1',
        });
    });
});
