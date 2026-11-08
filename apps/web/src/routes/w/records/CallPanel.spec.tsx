import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, renderAt, route, stubApi } from '../settings/settingsTestKit';
import { CallPanel } from './CallPanel';

const WS = 'ws-1';
const PERSON = '0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b';

const logged = () => ({
    id: '0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a01',
    provider: 'manual',
    personId: PERSON,
    memberId: 'm-1',
    direction: 'outbound',
    status: 'logged',
    fromNumber: null,
    toNumber: '+14155550100',
    startedAt: new Date().toISOString(),
    answeredAt: null,
    completedAt: null,
    durationSec: 0,
    hasVoicemail: false,
    recordings: [],
    summary: null,
    transcript: null,
    disposition: 'connected',
    noteId: null,
    quoLink: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
});

/** The panel as the person page opens it: a person with a US number, dialled in Quo. */
function panel(phone: { number: string; countryCode: string } | null) {
    return renderAt(
        [
            route(
                '/w/:workspaceId/people/:personId',
                <CallPanel
                    workspaceId={WS}
                    personId={PERSON}
                    personName="Dana Reyes"
                    phone={phone}
                    open
                    onOpenChange={() => undefined}
                />,
            ),
        ],
        `/w/${WS}/people/${PERSON}`,
        ['record:read', 'note:write'],
    );
}

describe('CALL-1 the Call panel', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('shows the number in E.164 for Quo, and logs the call with its outcome once one is picked', async () => {
        const seen = stubApi([(r) => (r.method === 'POST' && /\/calls$/.test(r.url) ? json(logged()) : undefined)]);
        panel({ number: '4155550100', countryCode: 'US' });
        expect(await screen.findByText('+14155550100 · opens in Quo')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Call in Quo' })).toBeEnabled();
        expect(screen.getByRole('timer', { name: 'Call timer' })).toHaveTextContent('00:00');
        expect(screen.getByRole('button', { name: 'Save call' })).toBeDisabled();
        await userEvent.click(screen.getByLabelText('Left voicemail'));
        await userEvent.click(screen.getByRole('button', { name: 'Save call' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'POST' && /\/calls$/.test(r.url))).toBe(true));
        const body = seen.find((r) => r.method === 'POST')?.body as {
            personId: string;
            direction: string;
            disposition: string;
            note?: unknown;
        };
        expect(body).toMatchObject({ personId: PERSON, direction: 'outbound', disposition: 'voicemail' });
        // Nothing typed: no empty note is written on the person.
        expect(body).not.toHaveProperty('note');
    });

    it('cannot dial a person with no number, and says so', async () => {
        stubApi([]);
        panel(null);
        expect(await screen.findByText('This person has no phone number the CRM can dial.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Call in Quo' })).toBeDisabled();
    });
});
