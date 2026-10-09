import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { inMode } from '../../../.storybook/modes';
import { RadioGroup } from './RadioGroup';

const meta = { title: 'Components/RadioGroup', component: RadioGroup } satisfies Meta<typeof RadioGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

const SCOPES = [
    { value: 'all', label: 'All records', description: 'Members see every person, company and deal.' },
    {
        value: 'own',
        label: 'Only records they own',
        description: 'Records owned by someone else are hidden, as if they did not exist.',
    },
] as const;

function Scope({ disabled }: { disabled?: boolean }) {
    const [value, setValue] = useState<'all' | 'own'>('own');
    return (
        <div className="max-w-md">
            <RadioGroup
                legend="Which records members see"
                options={SCOPES}
                value={value}
                onValueChange={setValue}
                disabled={disabled}
            />
        </div>
    );
}

export const Gallery: Story = {
    args: { legend: '', options: [], value: '', onValueChange: () => {} },
    render: () => (
        <div className="grid gap-6">
            <Scope />
            <Scope disabled />
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
