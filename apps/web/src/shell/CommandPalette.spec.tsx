import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commands } from '../commands/registry';
import { CommandPalette } from './CommandPalette';

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
        const { rerender } = render(<CommandPalette open onOpenChange={onOpenChange} />);

        expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
        expect(screen.getByText('Go to')).toBeInTheDocument();
        expect(screen.getByText('Account')).toBeInTheDocument();
        expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
        expect(screen.queryByText('Suggested')).not.toBeInTheDocument();

        await user.click(screen.getByText('Toggle theme'));
        expect(toggleTheme).toHaveBeenCalledTimes(1);
        expect(onOpenChange).toHaveBeenCalledWith(false);

        rerender(<CommandPalette open onOpenChange={onOpenChange} />);
        expect(await screen.findByText('Suggested')).toBeInTheDocument();
        off();
    });
});
