import type { SignupMode } from '@bylinecrm/shared';
import { ThemeProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../api/queries';
import { paths } from '../paths';
import { SignUp } from './SignUp';

function Where() {
    const location = useLocation();
    return <output>{location.pathname}</output>;
}

function renderSignUp(initial: string) {
    const router = createMemoryRouter(
        [
            { path: paths.signUp, element: <SignUp /> },
            { path: paths.signIn, element: <Where /> },
            { path: '/w/:workspaceId/home', element: <Where /> },
        ],
        { initialEntries: [initial] },
    );
    return render(
        <QueryClientProvider client={createQueryClient()}>
            <ThemeProvider>
                <RouterProvider router={router} />
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

/** The first paint waits on the providers query; under a full parallel run that can take a while. */
const WAIT = { timeout: 5000 };

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

/** The API, as far as these pages call it; anything else is a test defect and answers 501. */
function stubApi(answers: Record<string, () => Promise<Response>>, signup: SignupMode) {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${new URL(url, 'http://x').pathname}`;
        if (key === 'GET /api/auth/providers') return json({ providers: [], signup });
        const answer = answers[key];
        return answer ? answer() : json({ statusCode: 501, code: 'not_implemented', message: key }, 501);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('SignUp (P0-14)', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('says sign-ups are closed, and offers no form, when the server is closed', async () => {
        stubApi({}, 'closed');
        renderSignUp(paths.signUp);
        expect(await screen.findByRole('heading', { name: 'Sign-ups are closed' }, WAIT)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Create workspace' })).not.toBeInTheDocument();
    });

    it('in invite mode, needs the sign-up invitation in the link and sends it with the form', async () => {
        const user = userEvent.setup();
        const fetchMock = stubApi(
            {
                'POST /api/auth/signup': () =>
                    json(
                        {
                            user: { id: 'u', email: 'new@client.example', emailVerified: true },
                            workspace: { id: 'ws-9', slug: 'n', name: 'New' },
                        },
                        201,
                    ),
            },
            'invite',
        );
        const first = renderSignUp(paths.signUp);
        expect(await screen.findByRole('heading', { name: 'Sign-ups are closed' }, WAIT)).toBeInTheDocument();
        first.unmount();

        renderSignUp(`${paths.signUp}?signup=sig-token`);
        await user.type(await screen.findByLabelText(/Work email/, {}, WAIT), 'new@client.example');
        await user.type(screen.getByLabelText(/Password/), 'correct horse battery staple');
        await user.type(screen.getByLabelText(/Workspace name/), 'New');
        await user.click(screen.getByRole('button', { name: 'Create workspace' }));
        expect(await screen.findByRole('status', {}, WAIT)).toHaveTextContent('/w/ws-9/home');
        const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/auth/signup'));
        expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ inviteToken: 'sig-token' });
    });

    it('accepts a workspace invitation while signed out, in every mode', async () => {
        const user = userEvent.setup();
        const fetchMock = stubApi(
            {
                'GET /api/auth/invites/inv-token': () =>
                    json({
                        email: 'owner@client.example',
                        workspaceName: 'Client Co',
                        expiresAt: '2026-10-20T00:00:00Z',
                    }),
                'POST /api/auth/invites/inv-token/signup': () =>
                    json({ id: 'ws-7', slug: 'c', name: 'Client Co' }, 201),
            },
            'closed',
        );
        renderSignUp(`${paths.signUp}?invite=inv-token`);
        expect(await screen.findByRole('heading', { name: 'Join Client Co' }, WAIT)).toBeInTheDocument();
        expect(screen.getByLabelText('Email')).toHaveValue('owner@client.example');
        await user.type(screen.getByLabelText(/Choose a password/), 'correct horse battery staple');
        await user.click(screen.getByRole('button', { name: 'Create account and join' }));
        expect(await screen.findByRole('status', {}, WAIT)).toHaveTextContent('/w/ws-7/home');
        // Signed out, the page never asked who is signed in: that 401 would have sent the person away.
        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/me'))).toBe(false);
    });

    it('sends an existing account to sign in and back when the address already has one', async () => {
        const user = userEvent.setup();
        stubApi(
            {
                'GET /api/auth/invites/inv-token': () =>
                    json({
                        email: 'owner@client.example',
                        workspaceName: 'Client Co',
                        expiresAt: '2026-10-20T00:00:00Z',
                    }),
                'POST /api/auth/invites/inv-token/signup': () =>
                    json(
                        { statusCode: 409, code: 'conflict.unique', message: 'sign in to accept this invitation' },
                        409,
                    ),
            },
            'closed',
        );
        renderSignUp(`${paths.signUp}?invite=inv-token`);
        await user.type(await screen.findByLabelText(/Choose a password/, {}, WAIT), 'correct horse battery staple');
        await user.click(screen.getByRole('button', { name: 'Create account and join' }));
        const links = await screen.findAllByRole('link', { name: 'Sign in to accept' });
        expect(links[0]).toHaveAttribute(
            'href',
            `${paths.signIn}?returnTo=${encodeURIComponent(`${paths.signUp}?invite=inv-token`)}`,
        );
    });

    it('says when an invitation was used or has expired', async () => {
        stubApi(
            {
                'GET /api/auth/invites/old': () =>
                    json({ statusCode: 410, code: 'gone', message: 'invitation already used' }, 410),
            },
            'closed',
        );
        renderSignUp(`${paths.signUp}?invite=old`);
        expect(
            await screen.findByRole('heading', { name: 'This invitation cannot be used' }, WAIT),
        ).toBeInTheDocument();
        expect(screen.getByText(/already used, or it has expired/)).toBeInTheDocument();
    });
});
