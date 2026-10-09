import { TooltipProvider } from '@bylinecrm/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../api/client';
import { InlineText, messageFor } from './InlineEdit';

function renderText(onSave: (v: string | null) => Promise<unknown>, canEdit = true) {
    return render(
        <TooltipProvider>
            <InlineText label="City" path="city" value="Austin" canEdit={canEdit} reason="read only" onSave={onSave} />
        </TooltipProvider>,
    );
}

describe('InlineText', () => {
    it('saves on Enter and shows the new value at once', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        renderText(onSave);
        await userEvent.click(screen.getByRole('button', { name: /City: Austin/ }));
        const input = screen.getByRole('textbox', { name: 'City' });
        await userEvent.clear(input);
        await userEvent.type(input, 'Toledo{Enter}');
        expect(onSave).toHaveBeenCalledWith('Toledo');
        expect(screen.getByRole('button', { name: /City: Toledo/ })).toBeInTheDocument();
    });

    it('reverts on Escape without saving', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        renderText(onSave);
        await userEvent.click(screen.getByRole('button', { name: /City: Austin/ }));
        await userEvent.type(screen.getByRole('textbox', { name: 'City' }), 'X{Escape}');
        expect(onSave).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: /City: Austin/ })).toBeInTheDocument();
    });

    it('rolls back and shows the field error when the API refuses', async () => {
        const onSave = vi
            .fn()
            .mockRejectedValue(
                new ApiError(400, 'validation.failed', 'invalid', [{ path: 'city', message: 'too long' }]),
            );
        renderText(onSave);
        await userEvent.click(screen.getByRole('button', { name: /City: Austin/ }));
        const input = screen.getByRole('textbox', { name: 'City' });
        await userEvent.clear(input);
        await userEvent.type(input, 'Somewhere{Enter}');
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('too long'));
        expect(screen.getByRole('button', { name: /City: Austin/ })).toBeInTheDocument();
    });

    it('is plain text with the reason when the reader cannot edit', () => {
        renderText(vi.fn(), false);
        const value = screen.getByRole('button', { name: /City: Austin/ });
        expect(value).toBeDisabled();
        expect(value).toHaveAttribute('title', 'read only');
    });

    it('clears a value to null rather than an empty string', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        renderText(onSave);
        await userEvent.click(screen.getByRole('button', { name: /City: Austin/ }));
        await userEvent.clear(screen.getByRole('textbox', { name: 'City' }));
        await userEvent.keyboard('{Enter}');
        expect(onSave).toHaveBeenCalledWith(null);
        expect(screen.getByRole('button', { name: /City: not set/ })).toBeInTheDocument();
    });
});

describe('messageFor', () => {
    it('prefers the field error that names the path, including a nested one', () => {
        const error = new ApiError(400, 'validation.failed', 'invalid', [
            { path: 'custom.beat', message: 'not an option' },
        ]);
        expect(messageFor(error, 'beat')).toBe('not an option');
        expect(messageFor(error, 'city')).toBe('invalid');
        expect(messageFor(new Error('boom'), 'city')).toBe('boom');
    });
});
