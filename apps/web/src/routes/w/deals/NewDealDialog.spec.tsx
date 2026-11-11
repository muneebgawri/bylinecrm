import { ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../../api/queries';
import type { PipelineView } from '../../../api/types';
import { NewDealDialog } from './NewDealDialog';

const WS = '11111111-2222-4333-8444-555555555555';

const PIPELINE = {
    id: 'pl1',
    name: 'Sales',
    isDefault: true,
    stages: [
        { id: 's1', name: 'New Opportunity', kind: 'open', position: 1, colour: 'neutral' },
        { id: 's9', name: 'Closed Won', kind: 'won', position: 9, colour: 'ok' },
    ],
} as unknown as PipelineView;

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Search finds Derek; Derek is at Acme; a create answers a deal. Every call is kept. */
function stubApi() {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
            calls.push({ method, url, body });
            if (url.includes('/search?'))
                return json({
                    person: [{ object: 'person', id: 'p1', title: 'Derek Young', subtitle: null }],
                    company: [],
                    opportunity: [],
                });
            if (url.endsWith('/people/p1'))
                return json({
                    id: 'p1',
                    nameFirst: 'Derek',
                    companyId: 'c1',
                    company: { id: 'c1', name: 'Acme Corp' },
                });
            if (method === 'POST' && url.endsWith('/opportunities'))
                return json({ id: 'd1', pipelineId: 'pl1', name: (body as { name: string }).name }, 201);
            return json({});
        }),
    );
    return calls;
}

function renderDialog(
    prefill: { contact?: { id: string; name: string }; company?: { id: string; name: string } } = {},
) {
    const onOpenChange = vi.fn();
    render(
        <ThemeProvider>
            <TooltipProvider>
                <QueryClientProvider client={createQueryClient()}>
                    <NewDealDialog
                        workspaceId={WS}
                        pipeline={PIPELINE}
                        open
                        onOpenChange={onOpenChange}
                        currency="USD"
                        {...prefill}
                    />
                </QueryClientProvider>
            </TooltipProvider>
        </ThemeProvider>,
    );
    return onOpenChange;
}

describe('New deal: a contact, and their company', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('picking a contact fills in their company; both are sent', async () => {
        const calls = stubApi();
        const onOpenChange = renderDialog();
        await userEvent.type(screen.getByLabelText(/^Name/), 'Press kit');
        await userEvent.click(screen.getByRole('button', { name: /^Contact:/ }));
        await userEvent.type(await screen.findByRole('combobox', { name: 'Search contact' }), 'derek');
        await userEvent.click(await screen.findByRole('option', { name: /Derek Young/ }, { timeout: 5000 }));
        expect(await screen.findByRole('button', { name: /^Company: Acme Corp/ })).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Create deal' }));
        await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
        expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
            name: 'Press kit',
            pointOfContactId: 'p1',
            companyId: 'c1',
            stageId: 's1',
        });
    });

    it('opened from a person, the contact and company are already there', async () => {
        const calls = stubApi();
        renderDialog({ contact: { id: 'p1', name: 'Derek Young' }, company: { id: 'c1', name: 'Acme Corp' } });
        expect(screen.getByRole('button', { name: /^Contact: Derek Young/ })).toBeInTheDocument();
        await userEvent.type(screen.getByLabelText(/^Name/), 'Renewal');
        await userEvent.click(screen.getByRole('button', { name: 'Create deal' }));
        await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
        expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ pointOfContactId: 'p1', companyId: 'c1' });
    });

    it('a deal still needs a company', async () => {
        const calls = stubApi();
        renderDialog();
        await userEvent.type(screen.getByLabelText(/^Name/), 'Orphan');
        await userEvent.click(screen.getByRole('button', { name: 'Create deal' }));
        expect(await screen.findByText('Pick the company this deal is with.')).toBeInTheDocument();
        expect(calls.some((c) => c.method === 'POST')).toBe(false);
    });
});
