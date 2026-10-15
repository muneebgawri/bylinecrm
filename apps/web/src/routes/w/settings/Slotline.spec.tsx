import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlotlineSettingsView } from '../../../api/types';
import { json, renderAt, route, stubApi } from './settingsTestKit';
import { Slotline } from './Slotline';

const empty: SlotlineSettingsView = {
    configured: false,
    baseUrl: null,
    hookUrl: null,
    triggers: ['BOOKING_CREATED', 'BOOKING_CANCELLED'],
    lastDeliveryAt: null,
    lastDeliveryResult: null,
    unmatchedOrganizers: 0,
    lastUnmatchedOrganizer: null,
};
const connected: SlotlineSettingsView = {
    ...empty,
    configured: true,
    baseUrl: 'https://bookings.acme.example',
    hookUrl: 'https://crm.example/api/hooks/slotline/tok',
};

const open = () =>
    renderAt([route('/w/:workspaceId/settings/slotline', <Slotline />)], '/w/ws-1/settings/slotline', [
        'workspace:admin',
    ]);

describe('CAL-2 Settings → Slotline', { timeout: 20_000 }, () => {
    afterEach(() => vi.unstubAllGlobals());

    it('asks for the booking site and a long enough secret, then shows the webhook to add in Slotline', async () => {
        let current = empty;
        const seen = stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/integrations/slotline') ? json(current) : undefined),
            (r) => {
                if (r.method !== 'PUT' || !r.url.endsWith('/integrations/slotline')) return undefined;
                current = connected;
                return json(current);
            },
        ]);
        open();
        const site = await screen.findByLabelText(/Booking site/);
        await userEvent.clear(site);
        await userEvent.type(site, 'https://bookings.acme.example');
        await userEvent.type(screen.getByLabelText(/Webhook secret/), 'too-short');
        await userEvent.click(screen.getByRole('button', { name: 'Connect Slotline' }));
        expect(await screen.findByText(/at least 16 characters/)).toBeInTheDocument();
        expect(seen.find((r) => r.method === 'PUT')).toBeUndefined();

        await userEvent.type(screen.getByLabelText(/Webhook secret/), '-but-now-long-enough');
        await userEvent.click(screen.getByRole('button', { name: 'Connect Slotline' }));
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({
                baseUrl: 'https://bookings.acme.example',
                secret: 'too-short-but-now-long-enough',
            }),
        );
        const hook = await screen.findByRole('region', { name: 'Webhook to add in Slotline' });
        expect(hook).toHaveTextContent('https://crm.example/api/hooks/slotline/tok');
        expect(screen.getByRole('link', { name: /webhooks\/new\?platform=true/ })).toHaveAttribute(
            'href',
            'https://bookings.acme.example/settings/developer/webhooks/new?platform=true',
        );
        expect(screen.getByText('Nothing received yet')).toBeInTheDocument();
    });

    it('says when deliveries are refused for their signature, and when bookings had no member to go to', async () => {
        stubApi([
            (r) =>
                r.method === 'GET' && r.url.endsWith('/integrations/slotline')
                    ? json({
                          ...connected,
                          lastDeliveryAt: '2026-10-15T09:00:00Z',
                          lastDeliveryResult: 'bad_signature',
                          unmatchedOrganizers: 2,
                          lastUnmatchedOrganizer: 'stranger@acme.example',
                      })
                    : undefined,
        ]);
        open();
        expect(await screen.findByText('Secret does not match')).toBeInTheDocument();
        expect(screen.getByText(/2 bookings were left/)).toHaveTextContent('stranger@acme.example');
    });
});
