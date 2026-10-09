import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from '../button/Button';
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    DialogTrigger,
} from './Dialog';

function Example() {
    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button>Open</Button>
            </DialogTrigger>
            <DialogContent>
                <DialogTitle>Delete deal?</DialogTitle>
                <DialogDescription>This cannot be undone.</DialogDescription>
                <DialogBody>
                    <input aria-label="Reason" />
                </DialogBody>
                <DialogFooter>
                    <Button variant="secondary">Cancel</Button>
                    <Button variant="danger">Delete</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

describe('Dialog', () => {
    it('opens from its trigger, traps focus inside, and closes on Escape returning focus', async () => {
        const user = userEvent.setup();
        render(<Example />);
        const trigger = screen.getByRole('button', { name: 'Open' });
        await user.click(trigger);

        const dialog = await screen.findByRole('dialog', { name: 'Delete deal?' });
        expect(dialog).toHaveAccessibleDescription('This cannot be undone.');

        // Tab around the whole dialog: focus must stay inside it.
        for (let i = 0; i < 6; i++) await user.tab();
        expect(dialog).toContainElement(document.activeElement as HTMLElement);

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});
