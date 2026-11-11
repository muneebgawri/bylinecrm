import type { Capability } from '@bylinecrm/shared';
import { ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../../api/queries';
import type { MembershipSummary } from '../../../api/types';
import { CapabilitiesProvider } from '../../../auth/capabilities';
import { PersonDeals } from './PersonDeals';

const WS = '11111111-2222-4333-8444-555555555555';

const PIPELINE = {
    id: 'pl1',
    name: 'Sales',
    isDefault: true,
    stages: [
        { id: 's1', name: 'New Opportunity', kind: 'open', position: 1, colour: 'neutral' },
        { id: 's2', name: 'Contacted', kind: 'open', position: 2, colour: 'info' },
        { id: 's9', name: 'Closed Won', kind: 'won', position: 9, colour: 'ok' },
    ],
};
const DEAL = {
    id: 'd1',
    name: 'Acme Corp — Derek',
    pipelineId: 'pl1',
    stageId: 's1',
    daysInStage: 2,
    currency: 'USD',
};

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubApi() {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init?: RequestInit) => {
            const url = String(input);
            const path = url.split('?')[0]!;
            const method = init?.method ?? 'GET';
            calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            if (method === 'POST' && path.endsWith('/move'))
                return json({ deal: { ...DEAL, stageId: 's2' }, rulesThatMayMoveItForward: [] });
            if (path.endsWith('/opportunities'))
                return json({ items: [DEAL], nextCursor: null, total: 1, totalIsEstimate: false });
            if (path.endsWith('/rules')) return json([]);
            if (path.endsWith('/pipelines/pl1')) return json(PIPELINE);
            if (path.endsWith('/pipelines')) return json([PIPELINE]);
            return json({});
        }),
    );
    return calls;
}

const member = (capabilities: Capability[]): MembershipSummary => ({
    memberId: 'm',
    workspaceId: WS,
    apiKeyId: null,
    userId: 'u',
    roleId: 'r',
    roleName: 'member',
    recordScope: 'all',
    capabilities,
});

function renderRail(capabilities: Capability[] = ['record:read', 'deal:read', 'deal:edit', 'deal:move']) {
    render(
        <ThemeProvider>
            <TooltipProvider>
                <QueryClientProvider client={createQueryClient()}>
                    <CapabilitiesProvider membership={member(capabilities)}>
                        <MemoryRouter>
                            <PersonDeals
                                workspaceId={WS}
                                person={{ id: 'p1', name: 'Derek' }}
                                company={{ id: 'c1', name: 'Acme Corp' }}
                            />
                        </MemoryRouter>
                    </CapabilitiesProvider>
                </QueryClientProvider>
            </TooltipProvider>
        </ThemeProvider>,
    );
}

describe("A person's Deals rail", () => {
    afterEach(() => vi.unstubAllGlobals());

    it('shows each deal’s stage and moves it in place through the one deal move', async () => {
        const calls = stubApi();
        renderRail();
        const stage = await screen.findByRole('button', { name: /Stage: New Opportunity/ }, { timeout: 10_000 });
        await userEvent.click(stage);
        const sheet = await screen.findByRole('dialog', { name: /Move “Acme Corp — Derek”/ });
        await userEvent.click(within(sheet).getByRole('button', { name: /Contacted/ }));
        await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
        const move = calls.find((c) => c.method === 'POST')!;
        expect(move.url).toContain('/opportunities/d1/move');
        expect(move.body).toEqual({ stageId: 's2' });
    });

    it('a closing stage asks first, as on the board', async () => {
        const calls = stubApi();
        renderRail();
        await userEvent.click(
            await screen.findByRole('button', { name: /Stage: New Opportunity/ }, { timeout: 10_000 }),
        );
        const sheet = await screen.findByRole('dialog', { name: /Move/ });
        await userEvent.click(within(sheet).getByRole('button', { name: /Closed Won/ }));
        expect(await screen.findByRole('dialog', { name: /Won|won|Close/ })).toBeInTheDocument();
        expect(calls.some((c) => c.method === 'POST')).toBe(false);
    });

    it('“New deal” opens with the person and their company filled in', async () => {
        stubApi();
        renderRail();
        await userEvent.click(await screen.findByRole('button', { name: '+ New deal' }, { timeout: 10_000 }));
        const dialog = await screen.findByRole('dialog', { name: 'New deal' });
        expect(within(dialog).getByRole('button', { name: /^Contact: Derek/ })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: /^Company: Acme Corp/ })).toBeInTheDocument();
    });

    it('without deal:move the stage is shown, not offered; without deal:edit there is no New deal', async () => {
        stubApi();
        renderRail(['record:read', 'deal:read']);
        expect(
            await screen.findByRole('button', { name: /Stage: New Opportunity/ }, { timeout: 10_000 }),
        ).toBeDisabled();
        expect(screen.queryByRole('button', { name: '+ New deal' })).toBeNull();
    });
});
