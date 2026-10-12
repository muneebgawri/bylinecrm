import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmailVerificationSettingsView } from '../../../api/types';
import { apiError, json, renderAt, route, stubApi, type FakeRoute } from './settingsTestKit';
import { Verification } from './Verification';

const settings: EmailVerificationSettingsView = { maxAgeDays: 90, isDefault: true, updatedAt: null };

let current = settings;
const listed: FakeRoute = (r) =>
    r.method === 'GET' && r.url.endsWith('/outreach/verification') ? json(current) : undefined;

const open = (capabilities: Parameters<typeof renderAt>[2]) =>
    renderAt(
        [route('/w/:workspaceId/settings/verification', <Verification />)],
        '/w/ws-1/settings/verification',
        capabilities,
    );

describe('P3-5 FR-CRMS-14 Settings → Verification', { timeout: 20_000 }, () => {
    afterEach(() => {
        current = settings;
        vi.unstubAllGlobals();
    });

    it('shows the re-verification age and what each result does at enrolment; a member who is not an admin reads only', async () => {
        stubApi([listed]);
        open(['outreach:write']);
        const age = await screen.findByLabelText(/Re-verify after/);
        expect(age).toHaveValue(90);
        expect(age).toBeDisabled();
        expect(screen.getByText(/An admin changes/)).toBeInTheDocument();
        // The four results, each with what the enrolment check does.
        const results = screen.getByRole('list', { name: 'Verification results' });
        const card = (label: string) => within(results).getByText(label).closest('li')!;
        for (const result of ['Valid', 'Invalid', 'Risky', 'Unknown']) expect(card(result)).toBeInTheDocument();
        expect(card('Unknown')).toHaveTextContent(/not enrolled/i);
        expect(card('Invalid')).toHaveTextContent(/Refused/);
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });

    it('saves a new age and shows the server’s field error at the field', async () => {
        const seen = stubApi([
            listed,
            (r) => {
                if (r.method !== 'PUT' || !r.url.endsWith('/outreach/verification')) return undefined;
                const body = r.body as { maxAgeDays: number };
                if (body.maxAgeDays > 365) {
                    return apiError(400, 'validation.failed', 'at most 365 days', [
                        { path: 'maxAgeDays', message: 'between 1 and 365 days' },
                    ]);
                }
                current = { maxAgeDays: body.maxAgeDays, isDefault: false, updatedAt: '2026-10-12T09:00:00Z' };
                return json(current);
            },
        ]);
        open(['outreach:write', 'workspace:admin']);
        const age = await screen.findByLabelText(/Re-verify after/);
        await userEvent.clear(age);
        await userEvent.type(age, '400');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('between 1 and 365 days')).toBeInTheDocument();

        await userEvent.clear(age);
        await userEvent.type(age, '30');
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(seen.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({ maxAgeDays: 30 }));
        // The page starts again from what the server now holds.
        await waitFor(() => expect(screen.getByLabelText(/Re-verify after/)).toHaveValue(30));
        expect(screen.getByText(/Set by your workspace/)).toBeInTheDocument();
    });
});
