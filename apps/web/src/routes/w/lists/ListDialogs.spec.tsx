import { ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../../api/queries';
import { CreateRecordDialog } from './ListDialogs';

const WS = '11111111-2222-4333-8444-555555555555';

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A person custom field, as the custom-fields list returns it. */
function field(over: Record<string, unknown>) {
    return {
        id: `f-${String(over['key'])}`,
        object: 'person',
        type: 'text',
        options: [],
        required: false,
        adminOnly: false,
        showOnCreate: false,
        position: 1,
        archivedAt: null,
        ...over,
    };
}
const PR_LINK = field({ key: 'pr_link', label: 'Pr link', type: 'url', showOnCreate: true, position: 1 });
const PR_TITLE = field({ key: 'pr_title', label: 'PR title', showOnCreate: true, position: 2 });
const BEAT = field({ key: 'beat', label: 'Beat', position: 3 });

/** The address check answers `holder`; a create answers a new person. Every call is kept. */
function stubApi(holder: { ownerName: string | null; trashed: boolean } | null, fields: unknown[] = []) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            if (url.includes('/people/address-check')) return json({ available: holder === null, holder });
            if (url.includes('/custom-fields')) return json(fields);
            if (url.includes('/search?'))
                return json({
                    person: [],
                    opportunity: [],
                    company: [{ object: 'company', id: 'c1', title: 'Acme Corp', subtitle: 'acme.com' }],
                });
            if (method === 'POST' && url.split('?')[0]!.endsWith('/people')) return json({ id: 'p9' }, 201);
            return json({});
        }),
    );
    return calls;
}

/** Picks Acme Corp in the required Company field. */
async function pickCompany() {
    await userEvent.click(screen.getByRole('button', { name: /^Company:/ }));
    await userEvent.type(await screen.findByRole('combobox', { name: 'Search company' }), 'acme');
    await userEvent.click(await screen.findByRole('option', { name: /Acme Corp/ }, { timeout: 3000 }));
}

function renderDialog() {
    const onCreated = vi.fn();
    render(
        <ThemeProvider>
            <TooltipProvider>
                <QueryClientProvider client={createQueryClient()}>
                    <CreateRecordDialog workspaceId={WS} object="person" onOpenChange={vi.fn()} onCreated={onCreated} />
                </QueryClientProvider>
            </TooltipProvider>
        </ThemeProvider>,
    );
    return onCreated;
}

describe('Add person: the address first', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('a taken address stops there, saying whose person it is', async () => {
        const calls = stubApi({ ownerName: 'Jane Doe', trashed: false });
        renderDialog();
        expect(screen.queryByLabelText(/First name/)).toBeNull();
        await userEvent.type(screen.getByLabelText(/Email/), 'dyoung@ftrintel.com');
        await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Jane Doe already has this person.');
        expect(screen.queryByLabelText(/First name/)).toBeNull();
        expect(calls.some((c) => c.method === 'POST')).toBe(false);
        expect(calls.find((c) => c.url.includes('/address-check'))!.url).toContain('email=dyoung%40ftrintel.com');
    });

    it('a free address opens the details, and the person is saved with them', async () => {
        const calls = stubApi(null);
        const onCreated = renderDialog();
        await userEvent.type(screen.getByLabelText(/Email/), 'new@lead.example');
        await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
        await userEvent.type(await screen.findByLabelText(/First name/), 'Derek');
        await userEvent.type(screen.getByLabelText(/Last name/), 'Young');
        await userEvent.type(screen.getByLabelText(/^Phone/), '888-988-1699');
        await userEvent.type(screen.getByLabelText(/Ext\./), '204');
        await pickCompany();
        await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
        await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('p9'));
        expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
            nameFirst: 'Derek',
            nameLast: 'Young',
            emails: { primary: 'new@lead.example' },
            phones: { primary: { number: '8889881699', countryCode: 'US', extension: '204' } },
            companyId: 'c1',
        });
    });

    it('a lead with no address skips the check', async () => {
        const calls = stubApi(null);
        renderDialog();
        await userEvent.click(screen.getByRole('button', { name: /Continue without one/ }));
        expect(await screen.findByLabelText(/First name/)).toBeInTheDocument();
        expect(calls.some((c) => c.url.includes('/address-check'))).toBe(false);
    });

    it('the company is required', async () => {
        stubApi(null);
        renderDialog();
        await userEvent.click(screen.getByRole('button', { name: /Continue without one/ }));
        await userEvent.type(await screen.findByLabelText(/First name/), 'Derek');
        expect(screen.getByRole('button', { name: 'Add person' })).toBeDisabled();
        await pickCompany();
        expect(screen.getByRole('button', { name: 'Add person' })).toBeEnabled();
    });

    it('asks the fields an admin chose, in their order, and saves them in their types', async () => {
        const calls = stubApi(null, [PR_TITLE, BEAT, PR_LINK]);
        renderDialog();
        await userEvent.type(screen.getByLabelText(/Email/), 'new@lead.example');
        await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
        await userEvent.type(await screen.findByLabelText(/First name/), 'Derek');
        const link = await screen.findByLabelText(/Pr link/);
        const title = screen.getByLabelText(/PR title/);
        expect(link.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.queryByLabelText(/Beat/)).toBeNull();
        await userEvent.type(link, 'www.prweb.com/x');
        await userEvent.type(title, 'Acme launches');
        await pickCompany();
        await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
        await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
        expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
            companyId: 'c1',
            custom: { pr_link: 'https://www.prweb.com/x', pr_title: 'Acme launches' },
        });
    });

    it('a required field is always asked, and must be filled', async () => {
        stubApi(null, [field({ key: 'beat', label: 'Beat', required: true })]);
        renderDialog();
        await userEvent.click(screen.getByRole('button', { name: /Continue without one/ }));
        await userEvent.type(await screen.findByLabelText(/First name/), 'Derek');
        await pickCompany();
        const beat = await screen.findByLabelText(/Beat/);
        expect(screen.getByRole('button', { name: 'Add person' })).toBeDisabled();
        await userEvent.type(beat, 'Fintech');
        expect(screen.getByRole('button', { name: 'Add person' })).toBeEnabled();
    });
});
