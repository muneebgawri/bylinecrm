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
