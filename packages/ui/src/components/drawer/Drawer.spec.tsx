import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from '../button/Button';
import { Drawer, DrawerContent, DrawerTrigger } from './Drawer';

function Example() {
    return (
        <Drawer>
            <DrawerTrigger asChild>
                <Button>Open record</Button>
            </DrawerTrigger>
            <DrawerContent title="Person" actions={<Button size="sm">Enrol</Button>}>
                <p>Dana Reyes</p>
            </DrawerContent>
        </Drawer>
    );
}

describe('Drawer', () => {
    it('opens as a named dialog, closes on Escape, and returns focus to the trigger', async () => {
        const user = userEvent.setup();
        render(<Example />);
        const trigger = screen.getByRole('button', { name: 'Open record' });
        await user.click(trigger);
        const dialog = await screen.findByRole('dialog', { name: 'Person' });
        expect(dialog).toHaveTextContent('Dana Reyes');
        expect(screen.getByRole('button', { name: 'Enrol' })).toBeInTheDocument();

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it('closes from its own close button', async () => {
        const user = userEvent.setup();
        render(<Example />);
        await user.click(screen.getByRole('button', { name: 'Open record' }));
        await user.click(await screen.findByRole('button', { name: 'Close' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});
