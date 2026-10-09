import type { Meta, StoryObj } from '@storybook/react-vite';
import { Clock } from 'lucide-react';
import { inMode } from '../../../.storybook/modes';
import { CardChip, DealCard, KanbanBoard, KanbanLane } from './Kanban';

const meta = { title: 'Shell/Kanban', component: KanbanLane } satisfies Meta<typeof KanbanLane>;
export default meta;
// Galleries render their own content; the story takes no args of its own.
type Story = StoryObj;

export const Gallery: Story = {
    render: () => (
        <KanbanBoard>
            <KanbanLane name="New" tone="neutral" count={12} sum="$48,000" more="10 more">
                <DealCard
                    reference="BC-128"
                    priority={{ label: '⚑ High', status: 'accent' }}
                    title="Series B PR"
                    company="Acme Corp"
                    chips={
                        <>
                            <CardChip>
                                <Clock aria-hidden /> Close Oct 31
                            </CardChip>
                            <CardChip>Replied 4h ago</CardChip>
                        </>
                    }
                    amount="$12,000"
                    owner={{ name: 'Kate Morgan' }}
                    age="3d in stage"
                />
                <DealCard
                    reference="BC-131"
                    priority={{ label: '⚑ Normal' }}
                    title="Funding round"
                    company="Stark Industries"
                    chips={
                        <CardChip>
                            <Clock aria-hidden /> Close Nov 15
                        </CardChip>
                    }
                    amount="$5,000"
                    owner={{ name: 'Tony Stark', tone: 'success' }}
                    age="1d"
                />
            </KanbanLane>
            <KanbanLane name="Contacted" tone="info" count={8} sum="$31,500">
                <DealCard
                    reference="BC-102"
                    priority={{ label: '⚠ Quiet', status: 'warning' }}
                    title="Product PR"
                    company="Wayne Enterprises"
                    chips={<CardChip>21d · past threshold</CardChip>}
                    amount="$9,000"
                    owner={{ name: 'Bruce Wayne', tone: 'warning' }}
                    age="21d"
                />
            </KanbanLane>
            <KanbanLane name="Replied" tone="accent" count={5} sum="$22,000">
                <DealCard
                    reference="BC-124"
                    priority={{ label: '⚑ High', status: 'accent' }}
                    title="Rebrand"
                    company="Globex"
                    chips={<CardChip>Pricing call Fri</CardChip>}
                    amount="$8,000"
                    owner={{ name: 'Kate Morgan' }}
                    age="2d"
                    highlighted
                />
            </KanbanLane>
            <KanbanLane name="Won" tone="success" count={2} sum="$9,500">
                <DealCard
                    reference="BC-110"
                    priority={{ label: '✓ Won', status: 'success' }}
                    title="Annual plan"
                    company="Umbrella"
                    chips={<CardChip>Order paid in NewswireOS</CardChip>}
                    amount="$4,500"
                    owner={{ name: 'Kate Morgan' }}
                    age="Oct 2"
                />
            </KanbanLane>
        </KanbanBoard>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
