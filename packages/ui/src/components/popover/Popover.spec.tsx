import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from '../button/Button';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';

describe('Popover', () => {
    it('opens from its trigger, closes on Escape and returns focus', async () => {
        const user = userEvent.setup();
        render(
            <Popover>
                <PopoverTrigger asChild>
                    <Button>Filter</Button>
                </PopoverTrigger>
                <PopoverContent aria-label="Filter panel">
                    <input aria-label="Value" />
                </PopoverContent>
            </Popover>,
        );
        const trigger = screen.getByRole('button', { name: 'Filter' });
        await user.click(trigger);
        expect(await screen.findByRole('dialog', { name: 'Filter panel' })).toBeInTheDocument();
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog', { name: 'Filter panel' })).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});
