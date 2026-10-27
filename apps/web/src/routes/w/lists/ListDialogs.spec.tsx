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

/** The address check answers `holder`; a create answers a new person. Every call is kept. */
function stubApi(holder: { ownerName: string | null; trashed: boolean } | null) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            if (url.includes('/people/address-check')) return json({ available: holder === null, holder });
            if (method === 'POST' && url.split('?')[0]!.endsWith('/people')) return json({ id: 'p9' }, 201);
            return json({});
        }),
    );
    return calls;
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
        expect(calls[0]!.url).toContain('email=dyoung%40ftrintel.com');
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
        await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
        await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('p9'));
        expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
            nameFirst: 'Derek',
            nameLast: 'Young',
            emails: { primary: 'new@lead.example' },
            phones: { primary: { number: '8889881699', countryCode: 'US', extension: '204' } },
        });
    });

    it('a lead with no address skips the check', async () => {
        const calls = stubApi(null);
        renderDialog();
        await userEvent.click(screen.getByRole('button', { name: /Continue without one/ }));
        expect(await screen.findByLabelText(/First name/)).toBeInTheDocument();
        expect(calls).toHaveLength(0);
    });
});
