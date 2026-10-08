import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
    it('calls onClick when enabled', async () => {
        const onClick = vi.fn();
        render(<Button onClick={onClick}>Save</Button>);
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('is disabled and does not fire while loading, and says so to assistive tech', async () => {
        const onClick = vi.fn();
        render(
            <Button loading onClick={onClick}>
                Save
            </Button>,
        );
        const button = screen.getByRole('button', { name: 'Save' });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute('aria-busy', 'true');
        await userEvent.click(button);
        expect(onClick).not.toHaveBeenCalled();
    });

    it('renders as the child element with asChild', () => {
        render(
            <Button asChild>
                <a href="/people">People</a>
            </Button>,
        );
        expect(screen.getByRole('link', { name: 'People' })).toHaveAttribute('href', '/people');
    });
});
