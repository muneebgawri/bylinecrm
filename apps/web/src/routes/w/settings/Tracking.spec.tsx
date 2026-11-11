import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrackingDomainView, TrackingPolicyView, TrackingSettingsView } from '../../../api/types';
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

const policyOf = (over: Partial<TrackingPolicyView> = {}): TrackingPolicyView => ({
    provider: 'builtin',
    trackOpens: true,
    trackClicks: true,
    trackPersonalMail: false,
    gmailReplyNotices: true,
    smtp2go: {
        keySet: false,
        hookUrl: 'https://api.crm.example/api/hooks/smtp2go/relay/ws-1',
        hookAuthorization: null,
        lastHookAt: null,
        lastHookResult: null,
    },
    mailboxesWithoutCopy: [],
    ...over,
});

describe('TRACK-2 Settings → Tracking: how email is tracked', { timeout: 20_000 }, () => {
    afterEach(() => vi.unstubAllGlobals());

    const routes = (state: { policy: TrackingPolicyView }) => [
        (r: { method: string; url: string }) =>
            r.method === 'GET' && r.url.endsWith('/tracking/domain') ? json(settings(null)) : undefined,
        (r: { method: string; url: string }) =>
            r.method === 'GET' && r.url.endsWith('/tracking/policy') ? json(state.policy) : undefined,
        (r: { method: string; url: string; body?: unknown }) => {
            if (r.method !== 'PATCH' || !r.url.endsWith('/tracking/policy')) return undefined;
            const body = r.body as Record<string, unknown>;
            const { smtp2goApiKey, ...rest } = body;
            state.policy = {
                ...state.policy,
                ...(rest as Partial<TrackingPolicyView>),
                ...(typeof smtp2goApiKey === 'string'
                    ? {
                          smtp2go: {
                              ...state.policy.smtp2go,
                              keySet: true,
                              hookAuthorization: 'Bearer s3cret',
                          },
                      }
                    : {}),
            };
            return json(state.policy);
        },
    ];

    it('an admin switches what is tracked; each switch saves as it is flipped', async () => {
        const state = { policy: policyOf() };
        const seen = stubApi(routes(state));
        open(['workspace:admin']);
        await userEvent.click(await screen.findByRole('switch', { name: 'Track opens' }));
        await waitFor(() => expect(seen.find((r) => r.method === 'PATCH')?.body).toEqual({ trackOpens: false }));
        await userEvent.click(screen.getByRole('switch', { name: 'Track email written in the CRM by default' }));
        await waitFor(() =>
            expect(seen.filter((r) => r.method === 'PATCH').at(-1)?.body).toEqual({ trackPersonalMail: true }),
        );
        expect(
            screen.getByRole('switch', { name: 'Tell members when a contact replies to email sent from Gmail' }),
        ).toBeChecked();
    });

    it('SMTP2Go is chosen only once its key is saved; then the webhook to set up is shown', async () => {
        const state = { policy: policyOf() };
        const seen = stubApi(routes(state));
        open(['workspace:admin']);
        expect(await screen.findByRole('radio', { name: /SMTP2Go/ })).toBeDisabled();
        await userEvent.type(screen.getByLabelText('API key'), 'api-123456789');
        await userEvent.click(screen.getByRole('button', { name: 'Save key' }));
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'PATCH')?.body).toEqual({ smtp2goApiKey: 'api-123456789' }),
        );
        expect(await screen.findByText('Bearer s3cret')).toBeInTheDocument();
        expect(screen.getByText('https://api.crm.example/api/hooks/smtp2go/relay/ws-1')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('radio', { name: /SMTP2Go/ }));
        await waitFor(() =>
            expect(seen.filter((r) => r.method === 'PATCH').at(-1)?.body).toEqual({ provider: 'smtp2go' }),
        );
    });

    it('with SMTP2Go, names the mailboxes that cannot keep a copy in Gmail yet; a non-admin only reads', async () => {
        const state = {
            policy: policyOf({
                provider: 'smtp2go',
                smtp2go: { ...policyOf().smtp2go, keySet: true },
                mailboxesWithoutCopy: [{ id: 'mb-1', email: 'kate@pinionpartners.example' }],
            }),
        };
        stubApi(routes(state));
        open(['email:send']);
        expect(await screen.findByText('kate@pinionpartners.example')).toBeInTheDocument();
        expect(screen.getByRole('switch', { name: 'Track opens' })).toBeDisabled();
        expect(screen.queryByRole('button', { name: 'Save key' })).toBeNull();
    });
});
