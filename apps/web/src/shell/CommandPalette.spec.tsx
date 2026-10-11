import { render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commands } from '../commands/registry';
import { CommandPalette } from './CommandPalette';

/** The palette as the shell holds it: open until a command closes it. */
function Palette({ onOpenChange = () => undefined }: { onOpenChange?: (open: boolean) => void }) {
    const [open, setOpen] = useState(true);
    return (
        <CommandPalette
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                onOpenChange(next);
            }}
        />
    );
}

describe('CommandPalette', () => {
    afterEach(() => localStorage.clear());

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
        render(<CommandPalette open onOpenChange={onOpenChange} />);
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
