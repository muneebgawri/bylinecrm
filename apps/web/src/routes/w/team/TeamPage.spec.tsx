import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeadSuggestionView, MeetingKpisView, MeetingPage } from '../../../api/types';
import { json, renderAt, route, stubApi } from '../settings/settingsTestKit';
import { TeamPage } from './TeamPage';

const kpis: MeetingKpisView = { from: '2026-10-12T00:00:00Z', to: '2026-10-19T00:00:00Z', rows: [] };
const page: MeetingPage = { items: [], nextCursor: null };
const suggestion: LeadSuggestionView = {
    memberId: 'm-other',
    address: 'val@supplier.example',
    displayName: 'Val Vendor',
    meetings: [{ id: 'mt-1', title: 'Supplier call', startsAt: '2026-10-16T10:00:00Z' }],
    suggestedAt: '2026-10-15T10:00:00Z',
};

describe('CAL-3 Team → suggested leads', { timeout: 20_000 }, () => {
    afterEach(() => vi.unstubAllGlobals());

    it('adds a suggestion as a lead, or dismisses it, for the member it is for', async () => {
        let left = [suggestion];
        const seen = stubApi([
            (r) => (r.method === 'GET' && r.url.includes('/meetings/kpis') ? json(kpis) : undefined),
            (r) => (r.method === 'GET' && r.url.includes('/meetings/lead-suggestions') ? json(left) : undefined),
            (r) => (r.method === 'GET' && /\/meetings(\?|$)/.test(r.url) ? json(page) : undefined),
            (r) => (r.method === 'GET' && r.url.endsWith('/members/summary') ? json([]) : undefined),
            (r) => {
                if (r.method !== 'POST' || !r.url.endsWith('/lead-suggestions/accept')) return undefined;
                left = [];
                return json({ personId: 'p-1' });
            },
        ]);
        renderAt([route('/w/:workspaceId/team', <TeamPage />)], '/w/ws-1/team', ['record:read', 'workspace:admin']);
        expect(await screen.findByText('Val Vendor')).toBeInTheDocument();
        expect(screen.getByText('Supplier call')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: /Actions for Val Vendor/ }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Add as lead' }));
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'POST')?.body).toEqual({
                address: 'val@supplier.example',
                memberId: 'm-other',
            }),
        );
        expect(await screen.findByText('No suggestions')).toBeInTheDocument();
    });
});
