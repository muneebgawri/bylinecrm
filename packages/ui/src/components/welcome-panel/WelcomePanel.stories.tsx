import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../../../.storybook/modes';
import { Badge } from '../badge/Badge';
import { Button } from '../button/Button';
import { WelcomePanel } from './WelcomePanel';

const meta = { title: 'Shell/WelcomePanel', component: WelcomePanel } satisfies Meta<typeof WelcomePanel>;
export default meta;
// Galleries render their own content; the story takes no args of its own.
type Story = StoryObj;

export const Gallery: Story = {
    render: () => (
        <WelcomePanel
            chip={
                <Badge shape="pill" status="accent">
                    Rules worked overnight · 2 deals moved, 48 contacts re-verified
                </Badge>
            }
            title="Welcome back, Kate"
            body={
                <>
                    Replies are trending up <b className="text-text">12.4%</b> against last week, with{' '}
                    <b className="text-text">3 deals</b> and <b className="text-text">1 mailbox</b> needing your
                    attention.
                </>
            }
            facts={[
                { label: 'Pipeline value', value: '$130,000' },
                { label: 'Replies this week', value: '9' },
                { label: 'Active leads', value: '248' },
            ]}
            actions={
                <>
                    <Button shape="square">Refresh data</Button>
                    <Button shape="square" variant="primary">
                        Work the queue
                    </Button>
                </>
            }
        />
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
