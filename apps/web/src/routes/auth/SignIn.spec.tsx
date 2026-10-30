import type { SignupMode } from '@bylinecrm/shared';
import { ThemeProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../api/queries';
import { paths } from '../paths';
import { SignIn } from './SignIn';

function Where() {
    const location = useLocation();
    return <output>{location.pathname}</output>;
}

function renderSignIn(initial: string = paths.signIn) {
    const router = createMemoryRouter(
        [
            { path: paths.signIn, element: <SignIn /> },
            { path: '/w/:workspaceId/people', element: <Where /> },
            { path: paths.workspaces, element: <Where /> },
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

function stubApi(
    login: { status: number; body: unknown },
    signup: SignupMode = 'closed',
    twoFactor?: { status: number; body: unknown },
) {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/auth/providers'))
            return Promise.resolve(new Response(JSON.stringify({ providers: ['google'], signup }), { status: 200 }));
        if (url.endsWith('/auth/login/two-factor') && init?.method === 'POST' && twoFactor)
            return Promise.resolve(new Response(JSON.stringify(twoFactor.body), { status: twoFactor.status }));
        if (url.endsWith('/auth/login') && init?.method === 'POST')
            return Promise.resolve(new Response(JSON.stringify(login.body), { status: login.status }));
        return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('SignIn', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('offers the providers, posts the form, and returns the person where they were', async () => {
        const user = userEvent.setup();
        const fetchMock = stubApi({
            status: 200,
            body: { user: { id: 'u', email: 'a@b.c', emailVerified: true, twoFactorEnabled: false }, twoFactor: null },
        });
        renderSignIn(`${paths.signIn}?returnTo=${encodeURIComponent('/w/ws-1/people')}`);

        // The providers query resolves after the first paint; under a full parallel run that can take a while.
        expect(await screen.findByRole('link', { name: 'Continue with Google' }, { timeout: 5000 })).toHaveAttribute(
            'href',
            '/api/auth/oidc/google',
        );
        await user.type(screen.getByLabelText(/Email/), 'a@b.c');
        await user.type(screen.getByLabelText(/Password/), 'correct-horse-battery');
        await user.click(screen.getByRole('button', { name: 'Sign in' }));

        expect(await screen.findByRole('status')).toHaveTextContent('/w/ws-1/people');
        const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/auth/login'));
        expect(call?.[1]?.body).toBe(JSON.stringify({ email: 'a@b.c', password: 'correct-horse-battery' }));
    });

    it('asks for the authenticator code when the password answers with a challenge, then goes on (2FA-1)', async () => {
        const user = userEvent.setup();
        const fetchMock = stubApi({ status: 200, body: { user: null, twoFactor: { challenge: 'chal-1' } } }, 'closed', {
            status: 200,
            body: { user: { id: 'u', email: 'a@b.c', emailVerified: true, twoFactorEnabled: true } },
        });
        renderSignIn();
        await user.type(await screen.findByLabelText(/Email/), 'a@b.c');
        await user.type(screen.getByLabelText(/Password/), 'correct-horse-battery');
        await user.click(screen.getByRole('button', { name: 'Sign in' }));
        expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeInTheDocument();
        await user.type(screen.getByLabelText(/Authentication code/), '123456');
        await user.click(screen.getByRole('button', { name: 'Verify' }));
        expect(await screen.findByRole('status')).toHaveTextContent(paths.workspaces);
        const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/auth/login/two-factor'));
        expect(call?.[1]?.body).toBe(JSON.stringify({ challenge: 'chal-1', code: '123456' }));
    });

    it('says the pair does not match on a 401 without revealing which half', async () => {
        const user = userEvent.setup();
        stubApi({
            status: 401,
            body: { statusCode: 401, code: 'unauthorized', message: 'Unauthorized', requestId: 'req-0123456789' },
        });
        renderSignIn();
        await user.type(await screen.findByLabelText(/Email/), 'a@b.c');
        await user.type(screen.getByLabelText(/Password/), 'wrong');
        await user.click(screen.getByRole('button', { name: 'Sign in' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('That email and password do not match.');
    });

    it('hides "Create a workspace" unless sign-up is open (P0-14)', async () => {
        stubApi({ status: 200, body: {} }, 'closed');
        const closed = renderSignIn();
        expect(
            await screen.findByText(/Ask your administrator for an invitation/, {}, { timeout: 5000 }),
        ).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Create a workspace' })).not.toBeInTheDocument();
        closed.unmount();
        vi.unstubAllGlobals();

        stubApi({ status: 200, body: {} }, 'invite');
        const invite = renderSignIn();
        expect(
            await screen.findByText(/Ask your administrator for an invitation/, {}, { timeout: 5000 }),
        ).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Create a workspace' })).not.toBeInTheDocument();
        invite.unmount();
        vi.unstubAllGlobals();

        stubApi({ status: 200, body: {} }, 'open');
        renderSignIn();
        expect(await screen.findByRole('link', { name: 'Create a workspace' }, { timeout: 5000 })).toHaveAttribute(
            'href',
            paths.signUp,
        );
    });

    it('says sign-ups are closed when a provider sign-in was refused for that reason (P0-14)', async () => {
        stubApi({ status: 200, body: {} }, 'closed');
        renderSignIn(`${paths.signIn}?error=signup.closed`);
        expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent(
            'This server does not take new accounts. Ask your administrator for an invitation.',
        );
    });
});
