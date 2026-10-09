import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from '../button/Button';
import { Sheet, SheetContent, SheetTrigger } from './Sheet';

describe('Sheet', () => {
    it('opens as a named dialog with its footer, closes on its close button and returns focus', async () => {
        const user = userEvent.setup();
        render(
            <Sheet>
                <SheetTrigger asChild>
                    <Button>Sort</Button>
                </SheetTrigger>
                <SheetContent title="Sort people" footer={<Button>Apply</Button>}>
                    <p>Last name</p>
                </SheetContent>
            </Sheet>,
        );
        const trigger = screen.getByRole('button', { name: 'Sort' });
        await user.click(trigger);
        const dialog = await screen.findByRole('dialog', { name: 'Sort people' });
        expect(dialog).toHaveTextContent('Last name');
        expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Close' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});
