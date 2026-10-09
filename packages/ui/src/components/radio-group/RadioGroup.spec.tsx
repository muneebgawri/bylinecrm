import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { RadioGroup } from './RadioGroup';

const OPTIONS = [
    { value: 'all', label: 'All records', description: 'Every record.' },
    { value: 'own', label: 'Only records they own' },
] as const;

function Harness() {
    const [value, setValue] = useState<'all' | 'own'>('all');
    return (
        <>
            <RadioGroup legend="Which records members see" options={OPTIONS} value={value} onValueChange={setValue} />
            <output>{value}</output>
        </>
    );
}

describe('RadioGroup', () => {
    it('is a named group of radios; a click and the arrow keys change the choice', async () => {
        render(<Harness />);
        expect(screen.getByRole('group', { name: 'Which records members see' })).toBeInTheDocument();
        const all = screen.getByRole('radio', { name: /All records/ });
        expect(all).toBeChecked();
        await userEvent.click(screen.getByText('Only records they own'));
        expect(screen.getByRole('radio', { name: /Only records they own/ })).toBeChecked();
        expect(screen.getByRole('status')).toHaveTextContent('own');
        all.focus();
        await userEvent.keyboard('{ArrowDown}');
        expect(screen.getByRole('status')).toHaveTextContent('own');
    });

    it('describes an option with its sentence', () => {
        render(<Harness />);
        expect(screen.getByRole('radio', { name: /All records/ })).toBeInTheDocument();
        expect(screen.getByText('Every record.')).toBeInTheDocument();
    });
});
