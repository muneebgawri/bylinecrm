import type { Capability } from '@bylinecrm/shared';
import { ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../../api/queries';
import type { MembershipSummary } from '../../../api/types';
import { CapabilitiesProvider } from '../../../auth/capabilities';
import { OwnerControl } from './OwnerControl';

const WS = '11111111-2222-4333-8444-555555555555';
const MEMBERS = [
    { memberId: 'kate', name: 'Kate Uzzi', leftAt: null },
    { memberId: 'evan', name: 'Evan James', leftAt: null },
];
const PREVIEW = {
    total: 4,
    losers: [
        {
            member: { memberId: 'kate', name: 'Kate Uzzi' },
            companies: 1,
            people: 2,
            deals: 0,
            names: ['Matt Barr', 'Chad Dundas', 'Arvore Partners'],
        },
        {
            member: { memberId: 'alina', name: 'Alina Martin' },
            companies: 0,
            people: 1,
            deals: 0,
            names: ['Matt Barr'],
        },
    ],
};

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubApi(preview: unknown = PREVIEW) {
    const calls: { method: string; path: string }[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init?: RequestInit) => {
            const path = String(input).split('?')[0]!;
            const method = init?.method ?? 'GET';
            calls.push({ method, path });
            if (path.endsWith('/members/summary')) return json(MEMBERS);
            if (path.endsWith('/transfers/preview')) return json(preview);
            if (method === 'POST' && path.endsWith('/transfers')) {
                return json({
                    id: 't1',
                    to: { memberId: 'evan', name: 'Evan James' },
                    moved: [{}, {}, {}, {}],
                    status: 'forced',
                });
            }
            if (path.endsWith('/transfers')) return json([]);
            return json({});
        }),
    );
    return calls;
}

const manager: MembershipSummary = {
    memberId: 'noah',
    workspaceId: WS,
    apiKeyId: null,
    userId: 'u',
    roleId: 'r',
    roleName: 'manager',
    recordScope: 'all',
    capabilities: ['record:read', 'record:write', 'record:transfer'] satisfies Capability[],
};

function renderOwner(onSave = vi.fn(async () => undefined)) {
    render(
        <ThemeProvider>
            <TooltipProvider>
                <QueryClientProvider client={createQueryClient()}>
                    <CapabilitiesProvider membership={manager}>
                        <OwnerControl workspaceId={WS} object="person" recordId="p1" value="kate" onSave={onSave} />
                    </CapabilitiesProvider>
                </QueryClientProvider>
            </TooltipProvider>
        </ThemeProvider>,
    );
}

async function pick(name: string) {
    await userEvent.click(await screen.findByRole('combobox', { name: 'Owner' }));
    await userEvent.click(await screen.findByRole('option', { name }));
}

describe('OwnerControl — a manager’s move (OWN-1b)', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('shows who loses what before moving the whole company, and moves nothing when cancelled', async () => {
        const calls = stubApi();
        renderOwner();
        await pick('Evan James');

        const dialog = await screen.findByRole('dialog', { name: 'Move the whole company to Evan James?' });
        expect(within(dialog).getByText('Kate Uzzi')).toBeInTheDocument();
        expect(within(dialog).getByText(/loses the company and 2 contacts/)).toBeInTheDocument();
        expect(within(dialog).getByText('Alina Martin')).toBeInTheDocument();
        await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/transfers'))).toBe(false);
        expect(screen.getByRole('combobox', { name: 'Owner' })).toHaveTextContent('Kate Uzzi');
    });

    it('moves once confirmed', async () => {
        const calls = stubApi();
        renderOwner();
        await pick('Evan James');
        const dialog = await screen.findByRole('dialog');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Move 4 records' }));
        await waitFor(() =>
            expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/transfers'))).toHaveLength(1),
        );
    });

    it('moves a lone record without asking', async () => {
        const calls = stubApi({ total: 1, losers: [] });
        renderOwner();
        await pick('Evan James');
        await waitFor(() =>
            expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/transfers'))).toHaveLength(1),
        );
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});
