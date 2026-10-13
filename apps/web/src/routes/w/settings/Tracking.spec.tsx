import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrackingDomainView, TrackingSettingsView } from '../../../api/types';
import { json, renderAt, route, stubApi } from './settingsTestKit';
import { Tracking } from './Tracking';

const unchecked: TrackingDomainView = {
    domain: 'go.acme.example',
    status: 'unchecked',
    lastCheck: null,
    checkedAt: null,
    updatedAt: '2026-10-12T09:00:00Z',
};

const settings = (domain: TrackingDomainView | null): TrackingSettingsView => ({
    cnameTarget: 'api.crm.example',
    domain,
});

const open = (capabilities: Parameters<typeof renderAt>[2]) =>
    renderAt([route('/w/:workspaceId/settings/tracking', <Tracking />)], '/w/ws-1/settings/tracking', capabilities);

describe('P3-4 FR-CRMS-8 Settings → Tracking', { timeout: 20_000 }, () => {
    afterEach(() => vi.unstubAllGlobals());

    it('with no short-link domain yet, says links go out untracked and lets an admin set one', async () => {
        let current: TrackingDomainView | null = null;
        const seen = stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/tracking/domain') ? json(settings(current)) : undefined),
            (r) => {
                if (r.method !== 'PUT' || !r.url.endsWith('/tracking/domain')) return undefined;
                current = { ...unchecked, domain: (r.body as { domain: string }).domain };
                return json(settings(current));
            },
        ]);
        open(['workspace:admin']);
        expect(await screen.findByText(/untracked until/i)).toBeInTheDocument();
        await userEvent.type(await screen.findByLabelText(/Short-link domain/), 'go.acme.example');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({ domain: 'go.acme.example' }));
        // The record to publish, exactly: the name, the type, the target.
        const record = await screen.findByRole('region', { name: 'DNS record to publish' });
        expect(record).toHaveTextContent('go.acme.example');
        expect(record).toHaveTextContent('CNAME');
        expect(record).toHaveTextContent('api.crm.example');
        expect(screen.getByText('Not verified')).toBeInTheDocument();
    });

    it('checks the domain on demand and shows the outcome; a member without admin rights reads only', async () => {
        let current: TrackingDomainView = unchecked;
        stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/tracking/domain') ? json(settings(current)) : undefined),
            (r) => {
                if (r.method !== 'POST' || !r.url.endsWith('/tracking/domain/check')) return undefined;
                current = {
                    ...unchecked,
                    status: 'pass',
                    lastCheck: { outcome: 'pass', message: 'go.acme.example is a CNAME to api.crm.example' },
                    checkedAt: '2026-10-12T09:05:00Z',
                };
                return json(settings(current));
            },
        ]);
        open(['workspace:admin']);
        await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
        expect(await screen.findByText('Verified')).toBeInTheDocument();
        expect(screen.getByText(/is a CNAME to api.crm.example/)).toBeInTheDocument();
        expect(screen.getByText(/Opens are indicative/)).toBeInTheDocument();
    });

    it('a member without admin rights sees the domain and its state but no controls', async () => {
        stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/tracking/domain') ? json(settings(unchecked)) : undefined),
        ]);
        open(['outreach:write']);
        const record = await screen.findByRole('region', { name: 'DNS record to publish' });
        expect(within(record).getByText('go.acme.example')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
        expect(screen.getByText(/An admin changes/)).toBeInTheDocument();
    });
});
