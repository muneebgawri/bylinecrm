import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../../../.storybook/modes';
import { Delta } from '../delta/Delta';
import { ScoreBar } from '../score-bar/ScoreBar';
import { Avatar, AvatarCell } from './Avatar';

const meta = { title: 'Shell/Avatar', component: Avatar } satisfies Meta<typeof Avatar>;
export default meta;
// Galleries render their own content; the story takes no args of its own.
type Story = StoryObj;

export const Gallery: Story = {
    render: () => (
        <div className="flex flex-col gap-6">
            <div className="flex items-center gap-3">
                <Avatar name="Kate Morgan" size="xs" />
                <Avatar name="Sam Okafor" size="sm" tone="success" />
                <Avatar name="Dana Reyes" />
                <Avatar name="Priya Nair" tone="warning" />
                <Avatar name="Lena Vogt" tone="info" />
                <Avatar name="info@bigpr.com" size="lg" />
            </div>
            <div className="flex flex-col gap-3">
                <AvatarCell name="Dana Reyes" subline="Head of Comms" />
                <AvatarCell name="Sam Okafor" subline="VP Marketing" tone="success" />
                <AvatarCell
                    name="Kate Morgan"
                    subline="kate@pinionpartners.co"
                    size="sm"
                    nameAs={(n) => <a href="#kate">{n}</a>}
                />
            </div>
            <div className="flex flex-col gap-3">
                <ScoreBar value={8} />
                <ScoreBar value={10} />
                <ScoreBar value={2} />
            </div>
            <div className="flex gap-2">
                <Delta direction="up">12.4%</Delta>
                <Delta direction="down">2%</Delta>
                <Delta direction="down" good>
                    0.3
                </Delta>
            </div>
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
