import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { inMode } from '../../../.storybook/modes';
import { SegmentedControl } from './SegmentedControl';

const meta = { title: 'Shell/SegmentedControl', component: SegmentedControl } satisfies Meta<typeof SegmentedControl>;
export default meta;
// Galleries render their own content; the story takes no args of its own.
type Story = StoryObj;

function Example() {
    const [view, setView] = useState<'board' | 'list' | 'forecast'>('board');
    const [period, setPeriod] = useState<'1w' | '1m' | '6m' | '1y'>('1m');
    return (
        <div className="flex flex-col gap-4">
            <SegmentedControl
                aria-label="View"
                value={view}
                onValueChange={setView}
                options={[
                    { value: 'board', label: 'Board' },
                    { value: 'list', label: 'List' },
                    { value: 'forecast', label: 'Forecast' },
                ]}
            />
            <SegmentedControl
                aria-label="Period"
                value={period}
                onValueChange={setPeriod}
                options={[
                    { value: '1w', label: '1W' },
                    { value: '1m', label: '1M' },
                    { value: '6m', label: '6M' },
                    { value: '1y', label: '1Y', disabled: true },
                ]}
            />
        </div>
    );
}

export const Gallery: Story = { render: () => <Example /> };
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
