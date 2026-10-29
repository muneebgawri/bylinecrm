import { QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../api/queries';
import { commands } from '../commands/registry';
import { CommandPalette } from './CommandPalette';

const WS = '11111111-2222-4333-8444-555555555555';

function Where() {
    return <span data-testid="where">{useLocation().pathname}</span>;
}

function render(ui: ReactElement) {
    return rtlRender(
        <QueryClientProvider client={createQueryClient()}>
            <MemoryRouter>
                <Routes>
                    <Route
                        path="*"
                        element={
                            <>
                                {ui}
                                <Where />
                            </>
                        }
                    />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

/** The palette as the shell holds it: open until a command closes it. */
function Palette({ onOpenChange = () => undefined }: { onOpenChange?: (open: boolean) => void }) {
    const [open, setOpen] = useState(true);
    return (
        <CommandPalette
            workspaceId={WS}
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                onOpenChange(next);
            }}
        />
    );
}

describe('CommandPalette', () => {
    afterEach(() => {
        localStorage.clear();
        vi.unstubAllGlobals();
    });

    it('FR-CRMS-UI-4: finds a person by part of a name or email and opens them', async () => {
        const user = userEvent.setup();
        const fetchMock = vi.fn(
            async (_input: string) =>
                new Response(
                    JSON.stringify({
                        person: [
                            {
                                object: 'person',
                                id: 'p1',
                                title: 'Matt Smith',
                                subtitle: 'matt@acme.com',
                                owner: { memberId: 'm1', name: 'Jonah Reid', leftAt: null },
                                canOpen: true,
                            },
                            {
                                object: 'person',
                                id: 'p2',
                                title: 'Matt Jones',
                                subtitle: null,
                                owner: { memberId: 'm2', name: 'Dana Lee', leftAt: null },
                                canOpen: false,
                            },
                        ],
                        company: [],
                        opportunity: [],
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
        );
        vi.stubGlobal('fetch', fetchMock);
        render(<Palette />);

        await user.type(await screen.findByRole('combobox'), 'matt@ac');
        expect(await screen.findByText('Matt Smith')).toBeInTheDocument();
        expect(screen.getByText('Owner: Jonah Reid')).toBeInTheDocument();
        // Someone else's lead: named with its owner, but not opened.
        expect(screen.getByText('Owner: Dana Lee')).toBeInTheDocument();
        expect(screen.getByText('Matt Jones').closest('[cmdk-item]')).toHaveAttribute('aria-disabled', 'true');
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain('q=matt%40ac');
        await user.click(screen.getByText('Matt Smith'));
        await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/w/${WS}/people/p1`));
    });

    it('lists registered commands by group, runs one on select, and remembers it as suggested', async () => {
        const user = userEvent.setup();
        const goPeople = vi.fn();
        const toggleTheme = vi.fn();
        const off = commands.registerMany([
            { id: 'nav.people', title: 'People', group: 'Go to', shortcut: 'g p', run: goPeople },
            { id: 'theme.toggle', title: 'Toggle theme', group: 'Account', run: toggleTheme },
            { id: 'hidden', title: 'Hidden', group: 'Create', when: () => false, run: () => undefined },
        ]);
        const onOpenChange = vi.fn();
        const { unmount } = render(<Palette onOpenChange={onOpenChange} />);

        expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
        expect(screen.getByText('Go to')).toBeInTheDocument();
        expect(screen.getByText('Account')).toBeInTheDocument();
        expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
        expect(screen.queryByText('Suggested')).not.toBeInTheDocument();

        await user.click(screen.getByText('Toggle theme'));
        expect(onOpenChange).toHaveBeenCalledWith(false);
        await waitFor(() => expect(toggleTheme).toHaveBeenCalledTimes(1));

        unmount();
        render(<CommandPalette workspaceId={WS} open onOpenChange={onOpenChange} />);
        expect(await screen.findByText('Suggested')).toBeInTheDocument();
        off();
    });

    it('FR-CRMS-UI-4: lists the record’s own actions, “Email this person” among them', async () => {
        const compose = vi.fn();
        const off = commands.registerMany([
            { id: 'record.compose', title: 'Email this person', group: 'This record', shortcut: 'e', run: compose },
        ]);
        render(<Palette />);
        expect(await screen.findByText('This record')).toBeInTheDocument();
        await userEvent.click(screen.getByText('Email this person'));
        await waitFor(() => expect(compose).toHaveBeenCalledTimes(1));
        off();
    });
});
