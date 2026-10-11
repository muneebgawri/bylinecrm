import type { Capability } from '@bylinecrm/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, json, renderAt, route, stubApi, type FakeRoute } from '../settings/settingsTestKit';
import { Composer } from './Composer';
import { PERSON, WS, mailbox, mailboxesRoute, template } from './mailTestKit';
import { toLocalInput } from './schedule';

const CAN_SEND: Capability[] = ['email:send', 'mailbox:read', 'template:read', 'record:read'];

const MAILBOXES = [
    mailbox({ id: 'mb-mine', email: 'kate@example.com' }),
    mailbox({ id: 'mb-pool', email: 'outreach@example.com', purpose: 'pool' }),
    mailbox({ id: 'mb-sam', email: 'sam@example.com', ownerMemberId: 'm-2' }),
    mailbox({ id: 'mb-stale', email: 'kate.old@example.com', status: 'reconnect_needed' }),
];

const accepted = (status: 'queued' | 'scheduled' = 'queued', sendAt: string | null = null) =>
    json(
        {
            messageId: '0b1e0000-0000-4000-8000-00000000aa01',
            status,
            sendAt,
            senderTimeZone: sendAt ? 'Europe/London' : null,
            recipientTimeZone: null,
        },
        202,
    );

function composer(routes: FakeRoute[], props: Partial<Parameters<typeof Composer>[0]> = {}, capabilities = CAN_SEND) {
    const seen = stubApi(routes);
    renderAt(
        [route('/w/:workspaceId/people/:id', <Composer workspaceId={WS} person={PERSON} {...props} />)],
        `/w/${WS}/people/${PERSON.id}`,
        capabilities,
    );
    return seen;
}

async function write(subject: string, body: string) {
    await userEvent.type(await screen.findByRole('textbox', { name: 'Subject' }), subject);
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), body);
}

afterEach(() => vi.unstubAllGlobals());

describe('FR-CRMS-2: the compose box sends from the member’s own connected personal mailbox', () => {
    it('lists only their own personal, connected mailboxes under From — no pool, no one else’s', async () => {
        composer([mailboxesRoute(MAILBOXES)]);
        const from = await screen.findByRole('combobox', { name: 'From' });
        expect(from).toHaveTextContent('kate@example.com');
        await userEvent.click(from);
        const options = await screen.findAllByRole('option');
        expect(options.map((o) => o.textContent)).toEqual(['kate@example.com']);
    });

    it('with no mailbox to send from, says so in one line and links to Mailboxes', async () => {
        composer([mailboxesRoute([mailbox({ purpose: 'pool' }), mailbox({ ownerMemberId: 'm-2' })])]);
        expect(await screen.findByText('Connect a mailbox to email from here')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Mailboxes' })).toHaveAttribute('href', `/w/${WS}/mailboxes`);
        expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    });

    it('prefills To with the person and sends to them from the chosen mailbox', async () => {
        const seen = composer([
            mailboxesRoute(MAILBOXES),
            (r) => (r.method === 'POST' && r.url.endsWith('/mail/send') ? accepted() : undefined),
        ]);
        const to = await screen.findByRole('group', { name: 'To' });
        expect(within(to).getByText('Dana Reyes')).toBeInTheDocument();
        await write('Hello', 'Hi Dana');
        await userEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/mail/send'))).toBe(true));
        const body = seen.find((r) => r.url.endsWith('/mail/send'))?.body as Record<string, unknown>;
        expect(body).toMatchObject({ mailboxId: 'mb-mine', personId: PERSON.id, subject: 'Hello' });
        expect(body).not.toHaveProperty('to');
    });

    it('shows the server’s refusal in its words and keeps the draft', async () => {
        composer([
            mailboxesRoute(MAILBOXES),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/mail/send')
                    ? apiError(409, 'conflict', 'This mailbox needs reconnecting.')
                    : undefined,
        ]);
        await write('Hello', 'Hi Dana');
        await userEvent.click(screen.getByRole('button', { name: 'Send' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('This mailbox needs reconnecting.');
        expect(screen.getByRole('textbox', { name: 'Message' })).toHaveTextContent('Hi Dana');
    });
});

describe('FR-CRMS-3: a template fills the composer, and an empty variable holds Send', () => {
    const templateRoutes = (missing: string[]): FakeRoute[] => [
        mailboxesRoute(MAILBOXES),
        (r) =>
            r.method === 'GET' && r.url.includes('/templates?')
                ? json({ items: [template()], nextCursor: null })
                : undefined,
        (r) =>
            r.method === 'POST' && r.url.endsWith('/templates/t-1/preview')
                ? json({
                      subject: 'About Acme',
                      html: '<p>Hi</p>',
                      text: 'Hi',
                      missing,
                      sendable: missing.length === 0,
                  })
                : undefined,
        (r) => (r.method === 'POST' && r.url.endsWith('/mail/send') ? accepted() : undefined),
    ];

    async function pickTemplate() {
        await userEvent.click(await screen.findByRole('button', { name: 'Template' }));
        await userEvent.click(await screen.findByRole('button', { name: /Follow-up after a reply/ }));
    }

    it('offers personal templates only, and fills subject and body with variable chips', async () => {
        const seen = composer(templateRoutes([]));
        await pickTemplate();
        await waitFor(() =>
            expect(screen.getByRole('textbox', { name: 'Message' })).toHaveTextContent('person.firstName'),
        );
        expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveTextContent('About company.name');
        const list = seen.find((r) => r.url.includes('/templates?'));
        expect(list?.url).toContain('kind=personal');
        const preview = seen.find((r) => r.url.endsWith('/preview'));
        expect(preview?.body).toEqual({ personId: PERSON.id });
    });

    it('turns an empty variable red, names it, and disables Send — never a blank send', async () => {
        const seen = composer(templateRoutes(['custom.lastOutlet']));
        await pickTemplate();
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('custom.lastOutlet is empty for Dana Reyes · Send is disabled');
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Schedule' })).toBeDisabled();
        const chip = screen.getByLabelText('Variable custom.lastOutlet, empty for this person');
        expect(chip).toHaveClass('variable-chip-missing');
        expect(seen.some((r) => r.url.endsWith('/mail/send'))).toBe(false);
    });

    it('sends a template left as filled as the template itself', async () => {
        const seen = composer(templateRoutes([]));
        await pickTemplate();
        const send = screen.getByRole('button', { name: 'Send' });
        await waitFor(() => expect(send).toBeEnabled());
        await userEvent.click(send);
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/mail/send'))).toBe(true));
        expect(seen.find((r) => r.url.endsWith('/mail/send'))?.body).toEqual({
            mailboxId: 'mb-mine',
            personId: PERSON.id,
            templateId: 't-1',
        });
    });

    it('says “edited — sends as written” once the filled template is changed', async () => {
        composer(templateRoutes([]));
        await pickTemplate();
        const message = screen.getByRole('textbox', { name: 'Message' });
        await waitFor(() => expect(message).toHaveTextContent('person.firstName'));
        expect(screen.queryByText('edited — sends as written')).not.toBeInTheDocument();
        await userEvent.type(message, '!');
        expect(await screen.findByText('edited — sends as written')).toBeInTheDocument();
    });

    it('marks the variables a refused send names (422), so the reason is on the chip', async () => {
        composer([
            ...templateRoutes([]).filter((_, i) => i !== 3),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/mail/send')
                    ? json(
                          {
                              statusCode: 422,
                              code: 'unprocessable',
                              message: 'these variables have no value for this person: custom.lastOutlet',
                              fieldErrors: [{ path: 'custom.lastOutlet', message: 'has no value' }],
                              requestId: 'req-test',
                          },
                          422,
                      )
                    : undefined,
        ]);
        await pickTemplate();
        const send = screen.getByRole('button', { name: 'Send' });
        await waitFor(() => expect(send).toBeEnabled());
        await userEvent.click(send);
        expect(
            await screen.findByText('custom.lastOutlet is empty for Dana Reyes · Send is disabled'),
        ).toBeInTheDocument();
        expect(send).toBeDisabled();
    });
});

describe('FR-CRMS-UI-2 / P2-5: scheduling a send', () => {
    it('names the sender’s zone, says the recipient’s is unknown, and refuses a time under the minimum lead', async () => {
        const seen = composer([mailboxesRoute(MAILBOXES)]);
        await write('Hi', 'Yo');
        await userEvent.click(screen.getByRole('button', { name: 'Schedule' }));
        const panel = await screen.findByRole('dialog', { name: 'Schedule send' });
        expect(within(panel).getByText(/^Your time zone: /)).toBeInTheDocument();
        expect(within(panel).getByText('Recipient’s zone unknown')).toBeInTheDocument();
        fireEvent.change(within(panel).getByLabelText('Send at'), { target: { value: toLocalInput(new Date()) } });
        await userEvent.click(within(panel).getByRole('button', { name: 'Schedule send' }));
        expect(await within(panel).findByRole('alert')).toHaveTextContent('Pick a time at least 1 minute from now.');
        expect(seen.some((r) => r.url.endsWith('/mail/send'))).toBe(false);
    });

    it('sends a valid time with the sender’s zone', async () => {
        const seen = composer([
            mailboxesRoute(MAILBOXES),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/mail/send')
                    ? accepted('scheduled', '2026-12-01T09:00:00.000Z')
                    : undefined,
        ]);
        await write('Hi', 'Yo');
        await userEvent.click(screen.getByRole('button', { name: 'Schedule' }));
        const panel = await screen.findByRole('dialog', { name: 'Schedule send' });
        await userEvent.click(within(panel).getByRole('button', { name: 'Schedule send' }));
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/mail/send'))).toBe(true));
        const body = seen.find((r) => r.url.endsWith('/mail/send'))?.body as Record<string, unknown>;
        expect(typeof body['sendAt']).toBe('string');
        expect(body['timeZone']).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });
});

describe('FR-CRMS-4: a reply', () => {
    it('goes from the thread’s mailbox and carries replyToMessageId', async () => {
        const seen = composer(
            [
                mailboxesRoute(MAILBOXES),
                (r) => (r.method === 'POST' && r.url.endsWith('/mail/send') ? accepted() : undefined),
            ],
            { reply: { messageId: 'msg-7', mailboxId: 'mb-mine', subject: 'Intro' } },
        );
        await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), 'Sounds good');
        await userEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/mail/send'))).toBe(true));
        const body = seen.find((r) => r.url.endsWith('/mail/send'))?.body as Record<string, unknown>;
        expect(body).toMatchObject({ mailboxId: 'mb-mine', personId: PERSON.id, replyToMessageId: 'msg-7' });
        expect(body).not.toHaveProperty('subject');
    });

    it('cannot reply from a mailbox that is not one of the member’s', async () => {
        composer([mailboxesRoute(MAILBOXES)], { reply: { messageId: 'msg-7', mailboxId: 'mb-sam', subject: 'Intro' } });
        expect(await screen.findByText(/not one of your connected ones/)).toBeInTheDocument();
    });
});
