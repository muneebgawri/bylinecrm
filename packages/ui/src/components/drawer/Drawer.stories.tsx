import type { Meta, StoryObj } from '@storybook/react-vite';
import { CreditCard, Mail, MessageSquareReply, Phone, Send } from 'lucide-react';
import { inMode } from '../../../.storybook/modes';
import { ActivityTimeline } from '../activity-timeline/ActivityTimeline';
import { Avatar } from '../avatar/Avatar';
import { Badge } from '../badge/Badge';
import { Button } from '../button/Button';
import { FactGrid } from '../fact-grid/FactGrid';
import { StageProgress } from '../stage-progress/StageProgress';
import { Drawer, DrawerContent, DrawerSection, DrawerTrigger } from './Drawer';

const meta = { title: 'Shell/Drawer', component: DrawerContent } satisfies Meta<typeof DrawerContent>;
export default meta;
// Galleries render their own content; the story takes no args of its own.
type Story = StoryObj;

/** The visual gate photographs the open panel; the story opens it by default. */
export const Gallery: Story = {
    render: () => (
        <Drawer defaultOpen>
            <DrawerTrigger asChild>
                <Button>Open record</Button>
            </DrawerTrigger>
            <DrawerContent
                title="Person"
                actions={
                    <>
                        <Button size="sm" shape="square">
                            Open full page ↗
                        </Button>
                        <Button size="sm" shape="square" variant="primary">
                            Enrol in sequence
                        </Button>
                    </>
                }
            >
                <div className="flex flex-wrap items-center gap-3.5 px-5.5 pt-5.5 pb-4">
                    <Avatar name="Dana Reyes" size="lg" />
                    <div>
                        <h3 className="m-0 text-xl font-semibold tracking-tight">Dana Reyes</h3>
                        <p className="m-0 mt-0.5 text-[13px] text-text-muted">
                            Head of Comms · Acme Corp · dana@acme.example
                        </p>
                    </div>
                    <div className="ml-auto flex gap-2">
                        <Button size="icon" aria-label="Email">
                            <Mail aria-hidden />
                        </Button>
                        <Button size="icon" aria-label="Call">
                            <Phone aria-hidden />
                        </Button>
                    </div>
                </div>
                <FactGrid
                    className="mx-5.5"
                    facts={[
                        { label: 'Owner', value: 'Kate Morgan' },
                        { label: 'Source', value: 'BylineAI' },
                        { label: 'Email status', value: 'Valid · 12d ago' },
                        { label: 'Country', value: 'United States' },
                    ]}
                />
                <StageProgress
                    className="mx-5.5 mt-3.5"
                    title="Deal · Acme Series B PR"
                    meta="$12,000 · Replied"
                    stages={[
                        { label: 'New' },
                        { label: 'Contacted' },
                        { label: 'Replied' },
                        { label: 'Meeting' },
                        { label: 'Won' },
                    ]}
                    current={2}
                />
                <DrawerSection
                    title="Latest activity"
                    count={3}
                    action={
                        <Button variant="ghost" size="sm">
                            View all
                        </Button>
                    }
                >
                    <ActivityTimeline
                        className="px-5.5 pb-2.5"
                        items={[
                            {
                                id: '1',
                                icon: <MessageSquareReply />,
                                actor: 'Dana Reyes',
                                action: 'replied to Intro v3',
                                time: 'Today 09:12',
                                chips: (
                                    <>
                                        <Badge>Contacted</Badge>
                                        <span className="text-text-faint">→</span>
                                        <Badge status="accent">Replied</Badge>
                                        <span className="text-xs text-text-muted">by rule</span>
                                    </>
                                ),
                            },
                            {
                                id: '2',
                                icon: <Send />,
                                tone: 'neutral',
                                actor: 'You',
                                action: 'sent Intro v3 · Cold intro, step 1',
                                time: '6 days ago',
                                chips: (
                                    <>
                                        <Badge status="success">✓ Delivered</Badge>
                                        <Badge>1 click</Badge>
                                    </>
                                ),
                            },
                            {
                                id: '3',
                                icon: <CreditCard />,
                                tone: 'success',
                                actor: 'Acme Corp',
                                action: 'paid an order in NewswireOS',
                                time: '20 days ago',
                                chips: <Badge>$1,200 · “Globex rebrand”</Badge>,
                            },
                        ]}
                    />
                </DrawerSection>
            </DrawerContent>
        </Drawer>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
