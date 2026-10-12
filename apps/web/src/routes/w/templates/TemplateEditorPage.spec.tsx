import { CAPABILITIES, formatPostalAddress, type Capability } from '@bylinecrm/shared';
import { MOBILE_QUERY, ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../../api/queries';
import type { EmailTemplateView, MembershipSummary } from '../../../api/types';
import { CapabilitiesProvider } from '../../../auth/capabilities';
import { VARIABLE_TRIGGER_EVENT, Variable } from '../../../components/rich-text/variableNode';
import { TemplateEditorPage } from './TemplateEditorPage';

const WS = '0b1e0000-0000-4000-8000-000000000001';
const TID = '0b1e0000-0000-4000-8000-0000000007a1';
const PERSON = '0b1e0000-0000-4000-8000-0000000000d1';

const template: EmailTemplateView = {
    id: TID,
    name: 'Intro — PR distribution offer',
    kind: 'personal',
    subject: 'Quick one for {{person.firstName}}',
    body: {
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'Hi ' },
                    { type: 'variable', attrs: { path: 'person.firstName' } },
                ],
            },
        ],
    },
    version: 3,
    createdBy: { kind: 'member', id: 'm1' },
    updatedBy: { kind: 'member', id: 'm1' },
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    deletedAt: null,
} as EmailTemplateView;

const variables = {
    standard: [
        { path: 'person.firstName', source: 'person', label: 'First name', type: 'text', optional: false },
        { path: 'company.name', source: 'company', label: 'Company name', type: 'text', optional: false },
    ],
    custom: [],
};

function membershipWith(capabilities: readonly Capability[]): MembershipSummary {
    return {
        workspaceId: WS,
        memberId: 'm1',
        apiKeyId: null,
        userId: 'u1',
        roleId: 'r1',
        roleName: 'admin',
        recordScope: 'all',
        capabilities: [...capabilities],
    };
}

type Handler = (method: string, url: string, body: unknown) => { status: number; json: unknown } | undefined;

function stubApi(extra?: Handler) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
            calls.push({ method, url, body });
            const custom = extra?.(method, url, body);
            const answer = custom ?? defaultAnswer(method, url);
            return Promise.resolve(
                new Response(JSON.stringify(answer.json), {
                    status: answer.status,
                    headers: { 'content-type': 'application/json' },
                }),
            );
        }),
    );
    return calls;
}

function defaultAnswer(method: string, url: string): { status: number; json: unknown } {
    if (url.endsWith('/templates/variables')) return { status: 200, json: variables };
    if (method === 'GET' && url.endsWith(`/templates/${TID}`)) return { status: 200, json: template };
    if (url.endsWith('/settings/mail'))
        return {
            status: 200,
            json: { postalAddress: null, defaultSenderName: null, unsubscribeFooterText: 'You asked for this.' },
        };
    return { status: 404, json: { statusCode: 404, code: 'not_found', message: 'Not found', requestId: 'r' } };
}

function renderEditor(capabilities: readonly Capability[] = CAPABILITIES) {
    const router = createMemoryRouter(
        [{ path: '/w/:workspaceId/templates/:templateId', element: <TemplateEditorPage /> }],
        {
            initialEntries: [`/w/${WS}/templates/${TID}`],
        },
    );
    return render(
        <QueryClientProvider client={createQueryClient()}>
            <ThemeProvider>
                <TooltipProvider>
                    <CapabilitiesProvider membership={membershipWith(capabilities)}>
                        <RouterProvider router={router} />
                    </CapabilitiesProvider>
                </TooltipProvider>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

function phoneMode() {
    const real = window.matchMedia;
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
        ...real(query),
        matches: query === MOBILE_QUERY,
    }));
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/**
 * What a keystroke does in ProseMirror: the text is offered to `handleTextInput` (where input rules
 * live) and inserted by the editor itself only when no plugin took it — at the editor's selection.
 */
function typeInto(editor: Editor, text: string) {
    for (const ch of text) {
        const { from, to } = editor.state.selection;
        const insert = () => editor.state.tr.insertText(ch, from, to);
        const handled = editor.view.someProp('handleTextInput', (f) => f(editor.view, from, to, ch, insert));
        if (!handled) editor.view.dispatch(insert());
    }
}

/** The Tiptap editor behind a rendered editor's textbox (Tiptap keeps it on its DOM node). */
function editorOf(textbox: HTMLElement): Editor {
    return (textbox as HTMLElement & { editor: Editor }).editor;
}

describe('the variable node', () => {
    it('turns a typed {{ into a request for the picker, leaving no braces behind', () => {
        const editor = new Editor({
            extensions: [StarterKit.configure({ link: false }), Variable],
            content: '<p>Hi </p>',
        });
        const trigger = vi.fn();
        editor.on(VARIABLE_TRIGGER_EVENT, trigger);
        editor.commands.focus('end');
        // What a keystroke does: ProseMirror offers the text to `handleTextInput` (where input rules
        // live) and inserts it itself only when no plugin took it.
        const type = (text: string) => {
            const { from, to } = editor.state.selection;
            const insert = () => editor.state.tr.insertText(text, from, to);
            const handled = editor.view.someProp('handleTextInput', (f) => f(editor.view, from, to, text, insert));
            if (!handled) editor.view.dispatch(insert());
        };
        type('{');
        type('{');
        expect(trigger).toHaveBeenCalledTimes(1);
        expect(editor.getText()).not.toContain('{');
        editor.commands.insertVariable('person.firstName');
        const json = JSON.stringify(editor.getJSON());
        expect(json).toContain('"type":"variable","attrs":{"path":"person.firstName"}');
        editor.destroy();
    });
    it('#108: puts the caret right after the chip, with no space of its own before what is typed next', () => {
        const editor = new Editor({
            extensions: [StarterKit.configure({ link: false }), Variable],
            // JSON, not HTML: the HTML parser would drop the trailing space this test depends on.
            content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }] }] },
        });
        editor.commands.focus('end');
        editor.commands.insertVariable('person.firstName');
        typeInto(editor, ', thanks');
        // renderText shows the chip as {{path}}: the comma follows it directly.
        expect(editor.getText()).toBe('Hi {{person.firstName}}, thanks');
        editor.destroy();
    });
});

describe('Template editor', () => {
    it('#76 the locked footer names the postal address’s country, the same string the sent email carries', async () => {
        const address = {
            line1: '123 Main St',
            line2: null,
            city: 'Austin',
            region: 'TX',
            postalCode: '78701',
            country: 'US',
        };
        stubApi((method, url) => {
            if (method === 'GET' && url.endsWith(`/templates/${TID}`))
                return { status: 200, json: { ...template, kind: 'outreach' } };
            if (url.endsWith('/settings/mail'))
                return {
                    status: 200,
                    json: {
                        postalAddress: address,
                        defaultSenderName: null,
                        unsubscribeFooterText: 'You asked for this.',
                    },
                };
            return undefined;
        });
        renderEditor();
        const footer = await screen.findByLabelText('Locked footer');
        expect(await within(footer).findByText(formatPostalAddress(address))).toBeInTheDocument();
        expect(within(footer).getByText(/United States$/)).toBeInTheDocument();
    });

    it('shows the stored subject and body with variables as chips', async () => {
        stubApi();
        renderEditor();
        const subject = await screen.findByRole('textbox', { name: 'Subject' });
        const chip = within(subject).getByLabelText('Variable person.firstName');
        expect(chip).toHaveAttribute('data-variable', 'person.firstName');
        expect(screen.getByRole('textbox', { name: 'Body' }).querySelector('[data-variable]')).not.toBeNull();
    });

    it('inserts a variable chosen in the picker as a chip, never as text', async () => {
        stubApi();
        const user = userEvent.setup();
        renderEditor();
        const body = await screen.findByRole('textbox', { name: 'Body' });
        expect(body.querySelectorAll('[data-variable="company.name"]')).toHaveLength(0);
        await user.click(screen.getByRole('button', { name: 'Insert variable' }));
        await user.click(await screen.findByRole('option', { name: /Company name/ }));
        await waitFor(() => expect(body.querySelectorAll('[data-variable="company.name"]')).toHaveLength(1));
        expect(body.textContent).not.toContain('{{');
        expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    });

    it('#108: picking a variable with the mouse puts the caret back in the body, right after the chip', async () => {
        stubApi();
        const user = userEvent.setup();
        renderEditor();
        const body = await screen.findByRole('textbox', { name: 'Body' });
        const editor = editorOf(body);
        editor.commands.focus('end');
        await user.click(screen.getByRole('button', { name: 'Insert variable' }));
        await user.click(await screen.findByRole('option', { name: /Company name/ }));
        await waitFor(() => expect(screen.queryByPlaceholderText('Search variables…')).toBeNull());
        // Tiptap focuses on the next animation frame; wait for it rather than for a fixed time.
        await waitFor(() => expect(body.contains(document.activeElement)).toBe(true));
        typeInto(editor, '!');
        expect(editor.getText()).toBe('Hi {{person.firstName}}{{company.name}}!');
    });

    it('#108: {{ then Enter on a variable inserts it and keeps typing in the body', async () => {
        stubApi();
        const user = userEvent.setup();
        renderEditor();
        const body = await screen.findByRole('textbox', { name: 'Body' });
        const editor = editorOf(body);
        editor.commands.focus('end');
        // Tiptap applies focus a frame later; type only once the body really has it, as a person would.
        await waitFor(() => expect(body).toHaveFocus());
        typeInto(editor, ' at {{');
        const search = await screen.findByPlaceholderText('Search variables…');
        await waitFor(() => expect(search).toHaveFocus());
        await user.keyboard('company name');
        await user.keyboard('{Enter}');
        await waitFor(() => expect(body.querySelectorAll('[data-variable="company.name"]')).toHaveLength(1));
        await waitFor(() => expect(body.contains(document.activeElement)).toBe(true));
        typeInto(editor, '.');
        expect(editor.getText()).toContain('at {{company.name}}.');
    });

    it('#108: {{ then Escape returns the caret to the body, where the braces were', async () => {
        stubApi();
        const user = userEvent.setup();
        renderEditor();
        const body = await screen.findByRole('textbox', { name: 'Body' });
        const editor = editorOf(body);
        editor.commands.focus('end');
        // Tiptap applies focus a frame later; type only once the body really has it, as a person would.
        await waitFor(() => expect(body).toHaveFocus());
        typeInto(editor, ' {{');
        await waitFor(() => expect(screen.getByPlaceholderText('Search variables…')).toHaveFocus());
        await user.keyboard('{Escape}');
        await waitFor(() => expect(body.contains(document.activeElement)).toBe(true));
        typeInto(editor, 'x');
        expect(editor.getText().endsWith(' x')).toBe(true);
    });

    it('#108: on a phone, a variable picked in the bottom sheet lands at the caret and keeps focus in the body', async () => {
        phoneMode();
        stubApi();
        const user = userEvent.setup();
        renderEditor();
        const body = await screen.findByRole('textbox', { name: 'Body' });
        const editor = editorOf(body);
        editor.commands.focus('end');
        await user.click(screen.getByRole('button', { name: 'Insert variable' }));
        const sheet = await screen.findByRole('dialog', { name: 'Insert variable' });
        await user.click(within(sheet).getByRole('option', { name: /Company name/ }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Insert variable' })).toBeNull());
        await waitFor(() => expect(body.contains(document.activeElement)).toBe(true));
        typeInto(editor, ',');
        expect(editor.getText()).toBe('Hi {{person.firstName}}{{company.name}},');
    });

    it('saves with the version it loaded, and offers reload or copy when someone saved first', async () => {
        const calls = stubApi((method, url) =>
            method === 'PATCH' && url.endsWith(`/templates/${TID}`)
                ? {
                      status: 409,
                      json: {
                          statusCode: 409,
                          code: 'conflict',
                          message: 'The template changed since version 3; it is now version 4.',
                          requestId: 'req-1',
                      },
                  }
                : undefined,
        );
        const user = userEvent.setup();
        renderEditor();
        const name = await screen.findByRole('textbox', { name: 'Name' });
        await user.type(name, ' v2');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        const dialog = await screen.findByRole('dialog', { name: 'Changed by someone else' });
        expect(within(dialog).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Save as copy' })).toBeInTheDocument();
        const patch = calls.find((c) => c.method === 'PATCH');
        expect(patch?.body).toMatchObject({
            name: 'Intro — PR distribution offer v2',
            subject: 'Quick one for {{person.firstName}}',
            version: 3,
        });
    });

    it('previews against a real person in a sandbox that runs no script, and names empty variables', async () => {
        stubApi((method, url) => {
            if (url.includes('/search')) {
                return {
                    status: 200,
                    json: {
                        person: [{ id: PERSON, title: 'Dana Reyes', subtitle: 'Acme' }],
                        company: [],
                        opportunity: [],
                    },
                };
            }
            if (method === 'POST' && url.endsWith(`/templates/${TID}/preview`)) {
                return {
                    status: 200,
                    json: {
                        subject: 'Quick one for {{person.firstName}}',
                        html: '<p>Hi <span data-missing-variable="person.firstName">{{person.firstName}}</span></p>',
                        text: 'Hi {{person.firstName}}',
                        missing: ['person.firstName'],
                        sendable: false,
                    },
                };
            }
            return undefined;
        });
        const user = userEvent.setup();
        renderEditor();
        await user.click(await screen.findByRole('button', { name: 'Preview as: —' }));
        await user.type(screen.getByPlaceholderText('Search preview as…'), 'Dana');
        await user.click(await screen.findByRole('option', { name: /Dana Reyes/ }));
        const frame = await screen.findByTitle('Email preview for Dana Reyes');
        expect(frame).toHaveAttribute('sandbox', '');
        expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
        expect(frame.getAttribute('srcdoc')).toContain('data-missing-variable="person.firstName"');
        expect(await screen.findByRole('status')).toHaveTextContent(
            '1 of 1 variable is empty for Dana Reyes: person.firstName.',
        );
        expect(screen.getByRole('button', { name: 'Send test to me' })).toBeDisabled();
    });

    it('on a phone, puts the editor and the preview on two tabs', async () => {
        phoneMode();
        stubApi();
        const user = userEvent.setup();
        renderEditor();
        const tabs = await screen.findByRole('tablist', { name: 'Template' });
        expect(within(tabs).getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('region', { name: 'Edit' })).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
        await user.click(within(tabs).getByRole('tab', { name: 'Preview' }));
        expect(await screen.findByRole('region', { name: 'Preview' })).toBeInTheDocument();
    });

    it('on a phone, opens the variable picker and the kind selector as bottom sheets', async () => {
        phoneMode();
        stubApi();
        const user = userEvent.setup();
        renderEditor();
        await user.click(await screen.findByRole('button', { name: 'Insert variable' }));
        const picker = await screen.findByRole('dialog', { name: 'Insert variable' });
        expect(within(picker).getByRole('option', { name: /First name/ })).toBeInTheDocument();
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Insert variable' })).toBeNull());
        await user.click(screen.getByRole('button', { name: 'Kind: Personal' }));
        const kind = await screen.findByRole('dialog', { name: 'Kind' });
        expect(within(kind).getByRole('radio', { name: /Outreach/ })).toBeInTheDocument();
    });

    it('is read-only for a role that cannot write templates, and says why', async () => {
        stubApi();
        renderEditor(CAPABILITIES.filter((c) => c !== 'template:write'));
        await screen.findByRole('textbox', { name: 'Body' });
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
        expect(screen.getByText('Your role cannot write templates.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Insert variable' })).toBeDisabled();
    });
});
