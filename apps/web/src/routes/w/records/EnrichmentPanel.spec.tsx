import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnrichmentHistoryView } from '../../../api/types';
import { json, renderAt, route, stubApi } from '../settings/settingsTestKit';
import { EnrichmentPanel } from './EnrichmentPanel';

const recordId = '0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b';
const answered: EnrichmentHistoryView = {
    object: 'company',
    recordId,
    lastAskedAt: '2026-10-12T08:00:00Z',
    pending: false,
    answers: [
        {
            id: 'a1',
            object: 'company',
            recordId,
            field: 'logo_url',
            source: 'website',
            status: 'answered',
            value: 'https://acme.example/logo.png',
            rank: 2,
            note: null,
            applied: true,
            askedAt: '2026-10-12T08:00:00Z',
        },
        {
            id: 'a2',
            object: 'company',
            recordId,
            field: 'x_url',
            source: 'website',
            status: 'no_answer',
            value: null,
            rank: 0,
            note: null,
            applied: false,
            askedAt: '2026-10-12T08:00:00Z',
        },
        {
            id: 'a3',
            object: 'company',
            recordId,
            field: 'mail_provider',
            source: 'dns',
            status: 'failed',
            value: null,
            rank: 0,
            note: 'DNS lookup for acme.example failed',
            applied: false,
            askedAt: '2026-10-12T08:00:00Z',
        },
    ],
};

const open = (capabilities: Parameters<typeof renderAt>[2]) =>
    renderAt(
        [
            route(
                '/w/:workspaceId/companies/:companyId',
                <EnrichmentPanel workspaceId="ws-1" object="company" recordId={recordId} />,
            ),
        ],
        `/w/ws-1/companies/${recordId}`,
        capabilities,
    );

describe('P4-2 FR-CRMS-15 the enrichment panel on a record', { timeout: 20_000 }, () => {
    afterEach(() => vi.unstubAllGlobals());

    it('lists each answer with its source and when it was asked, says no answer and failed plainly, and offers Enrich now', async () => {
        const seen = stubApi([
            (r) =>
                r.method === 'GET' && r.url.endsWith(`/enrichment/company/${recordId}`) ? json(answered) : undefined,
            (r) =>
                r.method === 'POST' && r.url.endsWith(`/enrichment/company/${recordId}`)
                    ? json({ ...answered, pending: true }, 202)
                    : undefined,
        ]);
        open(['record:read', 'record:write']);
        const panel = await screen.findByRole('region', { name: 'Enrichment' });
        const logo = (await within(panel).findByText('Logo')).closest('li')!;
        expect(logo).toHaveTextContent('acme.example/logo.png');
        expect(logo).toHaveTextContent(/Company website/);
        expect(within(logo).getByRole('link')).toHaveAttribute('href', 'https://acme.example/logo.png');
        expect(within(panel).getByText('X profile').closest('li')).toHaveTextContent(/No answer/);
        expect(within(panel).getByText('Mail provider').closest('li')).toHaveTextContent(/Failed/);
        await userEvent.click(within(panel).getByRole('button', { name: 'Enrich now' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'POST')).toBe(true));
        expect(await within(panel).findByText(/Asking the sources/)).toBeInTheDocument();
    });

    it('says a record has not been enriched yet, and a reader without write rights cannot ask', async () => {
        stubApi([
            (r) =>
                r.method === 'GET' && r.url.endsWith(`/enrichment/company/${recordId}`)
                    ? json({ object: 'company', recordId, lastAskedAt: null, pending: false, answers: [] })
                    : undefined,
        ]);
        open(['record:read']);
        const panel = await screen.findByRole('region', { name: 'Enrichment' });
        expect(await within(panel).findByText(/Not enriched yet/)).toBeInTheDocument();
        expect(within(panel).queryByRole('button', { name: 'Enrich now' })).toBeNull();
    });
});
