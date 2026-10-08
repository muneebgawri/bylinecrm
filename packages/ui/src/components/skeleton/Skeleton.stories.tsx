import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../../../.storybook/modes';
import { Skeleton } from './Skeleton';

const meta = { title: 'Components/Skeleton', component: Skeleton } satisfies Meta<typeof Skeleton>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A record page's three columns while loading — the shape of the content, so nothing shifts when it lands. */
export const RecordPage: Story = {
    render: () => (
        <div className="grid max-w-4xl grid-cols-[14rem_1fr_14rem] gap-6" aria-busy="true" aria-label="Loading record">
            <div className="grid gap-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
                <Skeleton className="h-9 w-3/4" />
            </div>
            <div className="grid gap-3">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-24" />
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
            </div>
            <div className="grid gap-3">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-16" />
            </div>
        </div>
    ),
};
export const RecordPageDark: Story = inMode(RecordPage, 'dark');
export const RecordPageCompact: Story = inMode(RecordPage, 'compact');
