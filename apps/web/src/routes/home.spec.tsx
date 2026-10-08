import type { HealthStatus } from '@bylinecrm/shared';
import { ThemeProvider } from '@bylinecrm/ui';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Home } from './home';

const ok: HealthStatus = { status: 'ok', db: 'ok', redis: 'ok', version: '0.0.0' };

function stubFetch(response: () => Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(response));
}

function renderHome() {
    return render(
        <ThemeProvider>
            <Home />
        </ThemeProvider>,
    );
}

describe('Home', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('shows the API health once it loads', async () => {
        stubFetch(() => Promise.resolve(new Response(JSON.stringify(ok), { status: 200 })));
        renderHome();
        expect(screen.getByLabelText('Checking the API')).toBeInTheDocument();
        expect(await screen.findByTestId('status')).toHaveTextContent('ok');
        expect(screen.getByText('0.0.0')).toBeInTheDocument();
    });

    it('says so when the API cannot be reached, and offers a retry', async () => {
        stubFetch(() => Promise.reject(new Error('Failed to fetch')));
        renderHome();
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('API unreachable');
        expect(alert).toHaveTextContent('Failed to fetch');
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });
});
