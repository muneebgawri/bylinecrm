import type { Meta, StoryObj } from '@storybook/react-vite';
import { Filter } from 'lucide-react';
import { inMode } from '../../../.storybook/modes';
import { Badge } from '../badge/Badge';
import { Button } from '../button/Button';
import { Delta } from '../delta/Delta';
import { SegmentedControl } from '../segmented-control/SegmentedControl';
import { PageHeader } from './PageHeader';

const meta = { title: 'Shell/PageHeader', component: PageHeader } satisfies Meta<typeof PageHeader>;
export default meta;
// Galleries render their own content; the story takes no args of its own.
type Story = StoryObj;

export const Gallery: Story = {
    render: () => (
        <div className="flex flex-col gap-8">
            <PageHeader
                title="Dashboard"
                chip={
                    <Badge shape="pill" status="success" dot>
                        Live
                    </Badge>
                }
                subtitle="Your pipeline, outreach and what needs attention today."
                actions={
                    <>
                        <Button shape="square">Oct 1 – Oct 9, 2026 ⌄</Button>
                        <Button shape="square">Export</Button>
                    </>
                }
            />
            <PageHeader
                title="People"
                chip={<Badge shape="pill">4,812</Badge>}
                subtitle="Leads and contacts in your portfolio. Verified before they are ever emailed."
                actions={
                    <>
                        <Button shape="square">Import</Button>
                        <Button shape="square" variant="primary">
                            Add person
                        </Button>
                    </>
                }
            />
            <PageHeader
                title="Deals"
                subtitle={
                    <>
                        Sales pipeline · $130k open · 30 deals · your portfolio <Delta direction="up">8%</Delta>
                    </>
                }
                actions={
                    <>
                        <SegmentedControl
                            aria-label="View"
                            value="board"
                            onValueChange={() => undefined}
                            options={[
                                { value: 'board', label: 'Board' },
                                { value: 'list', label: 'List' },
                                { value: 'forecast', label: 'Forecast' },
                            ]}
                        />
                        <Button shape="square">
                            <Filter aria-hidden /> Filter
                        </Button>
                        <Button shape="square" variant="primary">
                            New deal
                        </Button>
                    </>
                }
            />
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
