import { ThemeProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../api/queries';
import { paths } from '../paths';
import { ForgotPassword } from './ForgotPassword';
import { ResetPassword } from './ResetPassword';
import { VerifyEmail } from './VerifyEmail';

function Where() {
    const location = useLocation();
    return <output>{location.pathname}</output>;
}

function renderAt(initial: string) {
    const router = createMemoryRouter(
        [
            { path: paths.verifyEmail, element: <VerifyEmail /> },
            { path: paths.forgotPassword, element: <ForgotPassword /> },
            { path: paths.resetPassword, element: <ResetPassword /> },
            { path: paths.workspaces, element: <Where /> },
            { path: paths.signIn, element: <Where /> },
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

type Answer = { status: number; body?: unknown };
const json = ({ status, body }: Answer) =>
    Promise.resolve(new Response(status === 202 || status === 204 ? null : JSON.stringify(body ?? {}), { status }));

/** Answers by `METHOD path`; anything else is a test failure, so an unexpected call is visible. */
function stubApi(routes: Record<string, Answer>) {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${new URL(url, 'http://x').pathname}`;
        const answer = routes[key];
        if (!answer) return Promise.reject(new Error(`unexpected ${key}`));
        return json(answer);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const invalidToken = {
    status: 400,
    body: { statusCode: 400, code: 'token.invalid', message: 'invalid', requestId: 'req-0123456789' },
};

const callsTo = (fetchMock: ReturnType<typeof stubApi>, path: string) =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith(path));

describe('#93 verify-email page', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('does not spend the link on load — only when the person clicks', async () => {
        const user = userEvent.setup();
        const fetchMock = stubApi({ 'POST /api/auth/email/verify': { status: 204 } });
        renderAt(`${paths.verifyEmail}?token=abc`);
        const button = await screen.findByRole('button', { name: 'Verify my email' });
        expect(callsTo(fetchMock, '/auth/email/verify')).toHaveLength(0);
        await user.click(button);
        expect(await screen.findByRole('heading', { name: 'Your email is verified' })).toBeInTheDocument();
        const [, init] = callsTo(fetchMock, '/auth/email/verify')[0]!;
        expect(JSON.parse(String(init?.body))).toEqual({ token: 'abc' });
    });

    it('says when the link is spent or expired, and offers a new one', async () => {
        const user = userEvent.setup();
        stubApi({ 'POST /api/auth/email/verify': invalidToken });
        renderAt(`${paths.verifyEmail}?token=old`);
        await user.click(await screen.findByRole('button', { name: 'Verify my email' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/expired or was already used/);
        expect(screen.getByRole('link', { name: 'Get a new link' })).toHaveAttribute('href', paths.verifyEmail);
    });

    it('holds an unverified person with their address, and mails a new link on request', async () => {
        const user = userEvent.setup();
        const fetchMock = stubApi({
            'GET /api/me': { status: 200, body: { id: 'u', email: 'kate@example.com', emailVerified: false } },
            'POST /api/auth/email/verification': { status: 204 },
        });
        renderAt(paths.verifyEmail);
        expect(await screen.findByText('kate@example.com')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Send a new link' }));
        expect(await screen.findByText(/A new link is on its way/)).toBeInTheDocument();
        expect(callsTo(fetchMock, '/auth/email/verification')).toHaveLength(1);
    });

    it('sends a verified person on to their workspaces', async () => {
        stubApi({ 'GET /api/me': { status: 200, body: { id: 'u', email: 'k@e.com', emailVerified: true } } });
        renderAt(paths.verifyEmail);
        expect(await screen.findByText(paths.workspaces)).toBeInTheDocument();
    });
});

describe('#93 forgot-password page', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('posts the address and answers with "if", whatever the server knows', async () => {
        const user = userEvent.setup();
        const fetchMock = stubApi({ 'POST /api/auth/password/forgot': { status: 204 } });
        renderAt(paths.forgotPassword);
        await user.type(await screen.findByLabelText(/Email/), 'someone@example.com');
        await user.click(screen.getByRole('button', { name: 'Send reset link' }));
        expect(await screen.findByRole('status')).toHaveTextContent(/If an account uses someone@example.com/);
        const [, init] = callsTo(fetchMock, '/auth/password/forgot')[0]!;
        expect(JSON.parse(String(init?.body))).toEqual({ email: 'someone@example.com' });
    });
});

describe('#93 reset-password page', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('refuses two different passwords without asking the server', async () => {
        const user = userEvent.setup();
        const fetchMock = stubApi({});
        renderAt(`${paths.resetPassword}?token=t`);
        await user.type(await screen.findByLabelText(/^New password/), 'a long new passphrase');
        await user.type(screen.getByLabelText(/Confirm new password/), 'a different passphrase');
        await user.click(screen.getByRole('button', { name: 'Save and sign in' }));
        expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('saves the new password with the link and goes on signed in', async () => {
        const user = userEvent.setup();
        const fetchMock = stubApi({
            'POST /api/auth/password/reset': {
                status: 200,
                body: { user: { id: 'u', email: 'k@e.com', emailVerified: true } },
            },
        });
        renderAt(`${paths.resetPassword}?token=t`);
        await user.type(await screen.findByLabelText(/^New password/), 'a long new passphrase');
        await user.type(screen.getByLabelText(/Confirm new password/), 'a long new passphrase');
        await user.click(screen.getByRole('button', { name: 'Save and sign in' }));
        expect(await screen.findByText(paths.workspaces)).toBeInTheDocument();
        const [, init] = callsTo(fetchMock, '/auth/password/reset')[0]!;
        expect(JSON.parse(String(init?.body))).toEqual({ token: 't', password: 'a long new passphrase' });
    });

    it('says a spent or expired link no longer works, and offers a new one', async () => {
        const user = userEvent.setup();
        stubApi({ 'POST /api/auth/password/reset': invalidToken });
        renderAt(`${paths.resetPassword}?token=old`);
        await user.type(await screen.findByLabelText(/^New password/), 'a long new passphrase');
        await user.type(screen.getByLabelText(/Confirm new password/), 'a long new passphrase');
        await user.click(screen.getByRole('button', { name: 'Save and sign in' }));
        expect(await screen.findByRole('heading', { name: 'This link no longer works' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Send a new link' })).toHaveAttribute('href', paths.forgotPassword);
    });
});
