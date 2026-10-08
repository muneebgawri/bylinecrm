import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../../../.storybook/modes';
import { Badge } from './Badge';

const meta = { title: 'Components/Badge', component: Badge } satisfies Meta<typeof Badge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
    render: () => (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
                <Badge>Neutral</Badge>
                <Badge status="success">Verified</Badge>
                <Badge status="warning">Warming 3/14</Badge>
                <Badge status="danger">Paused</Badge>
                <Badge status="info">Scheduled</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
                <Badge dot>12 people</Badge>
                <Badge dot status="success">
                    Active
                </Badge>
                <Badge dot status="warning">
                    Risky
                </Badge>
                <Badge dot status="danger">
                    DNS failing
                </Badge>
                <Badge dot status="info">
                    Syncing
                </Badge>
            </div>
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
