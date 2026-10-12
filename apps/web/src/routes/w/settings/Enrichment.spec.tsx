import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnrichmentSettingsView } from '../../../api/types';
import { apiError, json, renderAt, route, stubApi, type FakeRoute } from './settingsTestKit';
import { Enrichment } from './Enrichment';

const settings: EnrichmentSettingsView = {
    reaskAfterDays: 90,
    sources: { website: true, dns: true, gravatar: true, email_domain: true },
    isDefault: true,
    updatedAt: null,
};

let current = settings;
const listed: FakeRoute = (r) =>
    r.method === 'GET' && r.url.endsWith('/enrichment/settings') ? json(current) : undefined;

const open = (capabilities: Parameters<typeof renderAt>[2]) =>
    renderAt(
        [route('/w/:workspaceId/settings/enrichment', <Enrichment />)],
        '/w/ws-1/settings/enrichment',
        capabilities,
    );

describe('P4-2 FR-CRMS-15 Settings → Enrichment', { timeout: 20_000 }, () => {
    afterEach(() => {
        current = settings;
        vi.unstubAllGlobals();
    });

    it('shows each free source on or off with what it finds, and the re-ask age; a member who is not an admin reads only', async () => {
        stubApi([listed]);
        open(['record:read']);
        const website = await screen.findByRole('switch', { name: /Company website/ });
        expect(website).toBeChecked();
        expect(website).toBeDisabled();
        expect(screen.getByRole('switch', { name: /Gravatar/ })).toBeChecked();
        expect(screen.getByText(/no paid API/i)).toBeInTheDocument();
        const age = screen.getByLabelText(/Ask again after/);
        expect(age).toHaveValue(90);
        expect(age).toBeDisabled();
        expect(screen.getByText(/An admin changes/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });

    it('turns a source off and changes the age in one save; the server’s field error shows at the field', async () => {
        const seen = stubApi([
            listed,
            (r) => {
                if (r.method !== 'PUT' || !r.url.endsWith('/enrichment/settings')) return undefined;
                const body = r.body as EnrichmentSettingsView;
                if (body.reaskAfterDays > 365) {
                    return apiError(400, 'validation.failed', 'at most 365 days', [
                        { path: 'reaskAfterDays', message: 'between 1 and 365 days' },
                    ]);
                }
                current = { ...body, isDefault: false, updatedAt: '2026-10-12T09:00:00Z' };
                return json(current);
            },
        ]);
        open(['record:read', 'workspace:admin']);
        await userEvent.click(await screen.findByRole('switch', { name: /Gravatar/ }));
        const age = screen.getByLabelText(/Ask again after/);
        await userEvent.clear(age);
        await userEvent.type(age, '400');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('between 1 and 365 days')).toBeInTheDocument();

        await userEvent.clear(age);
        await userEvent.type(age, '30');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() =>
            expect(seen.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({
                reaskAfterDays: 30,
                sources: { website: true, dns: true, gravatar: false, email_domain: true },
            }),
        );
        await waitFor(() => expect(screen.getByRole('switch', { name: /Gravatar/ })).not.toBeChecked());
        expect(screen.getByLabelText(/Ask again after/)).toHaveValue(30);
    });
});
