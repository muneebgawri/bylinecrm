import type { Capability } from '@bylinecrm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailDraftView } from '../../../api/types';
import { apiError, json, renderAt, route, stubApi, type FakeRoute } from '../settings/settingsTestKit';
import { Composer } from './Composer';
import { DRAFT_SAVE_DELAY_MS } from './draftSave';
import { PERSON, WS, draftsRoute, mailDraft, mailbox, mailboxesRoute } from './mailTestKit';

const CAN_SEND: Capability[] = ['email:send', 'mailbox:read', 'template:read', 'record:read'];
const doc = (text: string) => ({
    type: 'doc' as const,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const accepted = () =>
    json(
        {
            messageId: '0b1e0000-0000-4000-8000-00000000aa01',
            status: 'queued',
            sendAt: null,
            senderTimeZone: null,
            recipientTimeZone: null,
            followUps: [],
        },
        202,
    );
const sendRoute: FakeRoute = (r) => (r.method === 'POST' && r.url.endsWith('/mail/send') ? accepted() : undefined);
const sentBody = (seen: { url: string; body: unknown }[]) =>
    seen.find((r) => r.url.endsWith('/mail/send'))?.body as Record<string, unknown> | undefined;

function composer(routes: FakeRoute[], drafts = true) {
    const seen = stubApi([mailboxesRoute([mailbox({ id: 'mb-mine' })]), ...routes]);
    renderAt(
        [route('/w/:workspaceId/people/:id', <Composer workspaceId={WS} person={PERSON} drafts={drafts} />)],
        `/w/${WS}/people/${PERSON.id}`,
        CAN_SEND,
    );
    return seen;
}

async function write(subject: string, body: string) {
    await userEvent.type(await screen.findByRole('textbox', { name: 'Subject' }), subject);
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), body);
}

afterEach(() => vi.unstubAllGlobals());

describe('Cc and Bcc: anyone, by address or as a person', () => {
    it('takes a typed address no one in the CRM has, behind the Cc/Bcc toggle, and sends it as cc', async () => {
        const seen = composer([sendRoute], false);
        await write('Hello', 'Hi Dana');
        expect(screen.queryByRole('group', { name: 'Cc' })).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Cc/Bcc' }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Cc address' }), 'Pat@Client.example{Enter}');
        expect(within(screen.getByRole('group', { name: 'Cc' })).getByText('pat@client.example')).toBeInTheDocument();
        await userEvent.type(screen.getByRole('textbox', { name: 'Bcc address' }), 'me@agency.example,');
        await userEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(sentBody(seen)).toBeDefined());
        expect(sentBody(seen)).toMatchObject({
            cc: [{ address: 'pat@client.example' }],
            bcc: [{ address: 'me@agency.example' }],
        });
    });

    it('says what is not an address and keeps it to fix; takes several pasted at once; removes one', async () => {
        composer([], false);
        await screen.findByRole('textbox', { name: 'Subject' });
        await userEvent.click(screen.getByRole('button', { name: 'Cc/Bcc' }));
        const cc = screen.getByRole('textbox', { name: 'Cc address' });
        await userEvent.type(cc, 'pat@client{Enter}');
        expect(screen.getByText('“pat@client” is not an email address')).toBeInTheDocument();
        expect(cc).toHaveValue('pat@client');
        expect(cc).toHaveAttribute('aria-invalid', 'true');

        await userEvent.clear(cc);
        await userEvent.click(cc);
        await userEvent.paste('a@one.example, b@two.example');
        const group = screen.getByRole('group', { name: 'Cc' });
        expect(within(group).getByText('a@one.example')).toBeInTheDocument();
        expect(within(group).getByText('b@two.example')).toBeInTheDocument();
        await userEvent.click(within(group).getByRole('button', { name: 'Remove a@one.example' }));
        expect(within(group).queryByText('a@one.example')).not.toBeInTheDocument();
    });
});

describe('drafts: saved as you write, on leaving, and put back', () => {
    it('saves a moment after typing, then saves changes over the version it has', async () => {
        let version = 0;
        const seen = composer([
            draftsRoute(),
            (r) => {
                if (r.method === 'POST' && r.url.endsWith('/mail/drafts')) {
                    version = 1;
                    return json(mailDraft({ version, content: (r.body as MailDraftView).content }), 201);
                }
                if (r.method === 'PUT' && r.url.includes('/mail/drafts/')) {
                    version += 1;
                    return json(mailDraft({ version, content: (r.body as MailDraftView).content }));
                }
                return undefined;
            },
        ]);
        await write('Hello', 'Hi Dana');
        expect(seen.some((r) => r.url.endsWith('/mail/drafts') && r.method === 'POST')).toBe(false);
        await waitFor(
            () => expect(seen.some((r) => r.method === 'POST' && r.url.endsWith('/mail/drafts'))).toBe(true),
            {
                timeout: DRAFT_SAVE_DELAY_MS * 3,
            },
        );
        expect(seen.filter((r) => r.method === 'POST' && r.url.endsWith('/mail/drafts'))).toHaveLength(1);
        expect(await screen.findByText(/^Saved/)).toBeInTheDocument();

        await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), ', one more thing');
        await waitFor(() => expect(seen.some((r) => r.method === 'PUT')).toBe(true), {
            timeout: DRAFT_SAVE_DELAY_MS * 3,
        });
        expect(seen.find((r) => r.method === 'PUT')?.body).toMatchObject({ version: 1, content: { subject: 'Hello' } });
    });

    it('opens with the draft — subject, message, cc — and sending it names the draft, which goes with it', async () => {
        const saved = mailDraft({
            content: {
                mailboxId: 'mb-mine',
                cc: [{ address: 'pat@client.example' }],
                subject: 'Picking up',
                body: doc('Where we left off'),
            },
        });
        const seen = composer([draftsRoute([saved]), sendRoute]);
        expect(await screen.findByRole('textbox', { name: 'Subject' })).toHaveTextContent('Picking up');
        expect(screen.getByRole('textbox', { name: 'Message' })).toHaveTextContent('Where we left off');
        expect(within(screen.getByRole('group', { name: 'Cc' })).getByText('pat@client.example')).toBeInTheDocument();
        expect(screen.getByText('Draft')).toBeInTheDocument();
        // Opening is not an edit: nothing is saved.
        expect(seen.some((r) => r.method === 'PUT' || (r.method === 'POST' && r.url.endsWith('/mail/drafts')))).toBe(
            false,
        );

        await userEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(sentBody(seen)).toBeDefined());
        expect(sentBody(seen)).toMatchObject({
            draftId: saved.id,
            subject: 'Picking up',
            cc: [{ address: 'pat@client.example' }],
        });
        await waitFor(() =>
            expect(screen.getByRole('textbox', { name: 'Subject' })).not.toHaveTextContent('Picking up'),
        );
        expect(screen.queryByText('Draft')).not.toBeInTheDocument();
    });

    it('“Discard draft” deletes it and empties the composer', async () => {
        const saved = mailDraft({ content: { subject: 'Not this one', body: doc('Never mind') } });
        const seen = composer([
            draftsRoute([saved]),
            (r) =>
                r.method === 'DELETE' && r.url.endsWith(`/mail/drafts/${saved.id}`)
                    ? new Response(null, { status: 204 })
                    : undefined,
        ]);
        expect(await screen.findByRole('textbox', { name: 'Subject' })).toHaveTextContent('Not this one');
        await userEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'DELETE')).toBe(true));
        await waitFor(() =>
            expect(screen.getByRole('textbox', { name: 'Subject' })).not.toHaveTextContent('Not this one'),
        );
    });

    it('when another tab saved first, stops saving and offers that version or this one', async () => {
        const saved = mailDraft({ content: { subject: 'Mine', body: doc('From here') } });
        const theirs = mailDraft({ version: 2, content: { subject: 'Theirs', body: doc('From the other tab') } });
        let puts = 0;
        const seen = composer([
            draftsRoute([saved]),
            (r) => (r.method === 'GET' && r.url.endsWith(`/mail/drafts/${saved.id}`) ? json(theirs) : undefined),
            (r) => {
                if (r.method !== 'PUT') return undefined;
                puts += 1;
                return puts === 1
                    ? apiError(409, 'conflict', 'the draft was saved elsewhere since', [], {
                          draftId: saved.id,
                          version: 2,
                      })
                    : json(mailDraft({ version: 3, content: (r.body as MailDraftView).content }));
            },
        ]);
        await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), ' and more');
        const alert = await screen.findByRole('alert', {}, { timeout: DRAFT_SAVE_DELAY_MS * 3 });
        expect(alert).toHaveTextContent('saved in another tab');

        await userEvent.click(within(alert).getByRole('button', { name: 'Keep mine' }));
        await waitFor(() => expect(puts).toBe(2));
        expect(seen.filter((r) => r.method === 'PUT').at(-1)?.body).toMatchObject({ version: 2 });
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    });

    it('“Load that version” puts the other tab’s draft in the composer', async () => {
        const saved = mailDraft({ content: { subject: 'Mine', body: doc('From here') } });
        const theirs = mailDraft({ version: 2, content: { subject: 'Theirs', body: doc('From the other tab') } });
        composer([
            draftsRoute([saved]),
            (r) => (r.method === 'GET' && r.url.endsWith(`/mail/drafts/${saved.id}`) ? json(theirs) : undefined),
            (r) =>
                r.method === 'PUT'
                    ? apiError(409, 'conflict', 'the draft was saved elsewhere since', [], {
                          draftId: saved.id,
                          version: 2,
                      })
                    : undefined,
        ]);
        await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), ' and more');
        const alert = await screen.findByRole('alert', {}, { timeout: DRAFT_SAVE_DELAY_MS * 3 });
        await userEvent.click(within(alert).getByRole('button', { name: 'Load that version' }));
        await waitFor(() => expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveTextContent('Theirs'));
        expect(screen.getByRole('textbox', { name: 'Message' })).toHaveTextContent('From the other tab');
    });
});
