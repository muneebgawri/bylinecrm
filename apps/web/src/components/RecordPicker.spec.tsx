import { TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../api/queries';
import { SEARCH_DEBOUNCE_MS } from '../lib/useDebounced';
import { RecordPicker } from './RecordPicker';

const WS = '11111111-2222-4333-8444-555555555555';

function json(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('RecordPicker', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('searches once typing pauses, lists the matches and saves the one chosen', async () => {
        const user = userEvent.setup();
        const fetchMock = vi.fn(async (_input: string) =>
            json({
                person: [],
                company: [{ object: 'company', id: 'c1', title: 'Acme Corp', subtitle: 'acme.com' }],
                opportunity: [],
            }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const onChange = vi.fn();
        render(
            <TooltipProvider>
                <QueryClientProvider client={createQueryClient()}>
                    <RecordPicker
                        workspaceId={WS}
                        object="company"
                        label="Company"
                        value={null}
                        clearLabel="No company"
                        onChange={onChange}
                    />
                </QueryClientProvider>
            </TooltipProvider>,
        );

        await user.click(screen.getByRole('button', { name: 'Company: No company' }));
        await user.type(await screen.findByRole('combobox', { name: 'Search company' }), 'acm');
        // Three keystrokes, one request: nothing is asked while typing continues.
        expect(fetchMock).not.toHaveBeenCalled();

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: SEARCH_DEBOUNCE_MS * 8 });
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/w/${WS}/search?q=acm&limit=10&objects=company`);

        await user.click(await screen.findByRole('option', { name: /Acme Corp/ }));
        expect(onChange).toHaveBeenCalledWith('c1');
    });
});
