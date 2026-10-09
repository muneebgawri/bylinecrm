import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { initialsOf, toneFor } from '../avatar/Avatar';
import { SegmentedControl } from './SegmentedControl';

function Example() {
    const [value, setValue] = useState<'board' | 'list'>('board');
    return (
        <SegmentedControl
            aria-label="View"
            value={value}
            onValueChange={setValue}
            options={[
                { value: 'board', label: 'Board' },
                { value: 'list', label: 'List' },
            ]}
        />
    );
}

describe('SegmentedControl', () => {
    it('always has exactly one option on, and moves with the arrow keys', async () => {
        const user = userEvent.setup();
        render(<Example />);
        const board = screen.getByRole('radio', { name: 'Board' });
        const list = screen.getByRole('radio', { name: 'List' });
        expect(board).toHaveAttribute('data-state', 'on');

        await user.click(list);
        expect(list).toHaveAttribute('data-state', 'on');
        expect(board).toHaveAttribute('data-state', 'off');

        // Clicking the active option again keeps it on (a segmented control has no "none").
        await user.click(list);
        expect(list).toHaveAttribute('data-state', 'on');

        list.focus();
        await user.keyboard('{ArrowLeft}');
        expect(board).toHaveFocus();
    });
});

describe('Avatar helpers', () => {
    it('derives initials and a stable tone from a name', () => {
        expect(initialsOf('Dana Reyes')).toBe('DR');
        expect(initialsOf('info@bigpr.com')).toBe('I');
        expect(initialsOf('  R.  Ortiz ')).toBe('RO');
        expect(toneFor('Dana Reyes')).toBe(toneFor('Dana Reyes'));
        expect(['accent', 'success', 'warning', 'info']).toContain(toneFor('Kate Morgan'));
    });
});
