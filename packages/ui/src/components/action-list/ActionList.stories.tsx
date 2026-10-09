import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlertTriangle, MessageSquareReply, Moon, Phone } from 'lucide-react';
import { inMode } from '../../../.storybook/modes';
import { Badge } from '../badge/Badge';
import { Button } from '../button/Button';
import { ActionList } from './ActionList';

const meta = { title: 'Shell/ActionList', component: ActionList } satisfies Meta<typeof ActionList>;
export default meta;
// Galleries render their own content; the story takes no args of its own.
type Story = StoryObj;

export const Gallery: Story = {
    render: () => (
        <div className="grid gap-4 md:grid-cols-[3fr_2fr]">
            <div className="rounded-lg border border-border bg-surface shadow-sm">
                <h3 className="m-0 flex items-center gap-2 border-b border-border px-4.5 py-3.5 text-sm font-semibold">
                    Needs attention <Badge className="ml-auto">5</Badge>
                </h3>
                <ActionList
                    items={[
                        {
                            id: '1',
                            icon: <MessageSquareReply />,
                            title: 'Dana Reyes replied to your intro',
                            subtitle: 'Acme Corp · “send me the distribution list and pricing” · 4h ago',
                            actions: (
                                <Button variant="primary" size="sm" shape="square">
                                    Reply
                                </Button>
                            ),
                        },
                        {
                            id: '2',
                            icon: <AlertTriangle />,
                            tone: 'danger',
                            title: 'ops@pinionmail.net paused itself',
                            subtitle: 'Bounce 4.6% passed 3.0% at 09:41 · 12 queued sends moved',
                            actions: (
                                <Button size="sm" shape="square">
                                    Review
                                </Button>
                            ),
                        },
                        {
                            id: '3',
                            icon: <Moon />,
                            tone: 'warning',
                            title: 'Wayne Enterprises · Product PR has gone quiet',
                            subtitle: '21 days in Contacted · last touch step 2 of Cold intro',
                            actions: (
                                <>
                                    <Button size="sm" shape="square">
                                        Follow up
                                    </Button>
                                    <Button size="sm" variant="ghost">
                                        Snooze
                                    </Button>
                                </>
                            ),
                        },
                        {
                            id: '4',
                            icon: <Phone />,
                            tone: 'info',
                            title: 'Call Sam Okafor',
                            subtitle: 'Initech · sequence step 3 · no reply after two emails',
                            actions: (
                                <Button size="sm" shape="square">
                                    Done
                                </Button>
                            ),
                        },
                    ]}
                />
            </div>
            <div className="rounded-lg border border-border bg-surface shadow-sm">
                <h3 className="m-0 flex items-center gap-2 border-b border-border px-4.5 py-3.5 text-sm font-semibold">
                    Upcoming <span className="ml-auto text-[13px] font-normal text-text-muted">This week</span>
                </h3>
                <ActionList
                    items={[
                        {
                            id: 'thu',
                            icon: 'Thu',
                            tone: 'neutral',
                            title: 'Initech · IPO wire call',
                            subtitle: '10:00 – 10:30 · Sam Okafor · Google Meet',
                            actions: (
                                <Button size="xs" shape="square">
                                    Prep
                                </Button>
                            ),
                        },
                        {
                            id: 'fri',
                            icon: 'Fri',
                            tone: 'neutral',
                            title: 'Globex · rebrand pricing',
                            subtitle: '14:00 – 14:30 · Dana Reyes',
                            actions: (
                                <Button size="xs" shape="square">
                                    Prep
                                </Button>
                            ),
                        },
                    ]}
                />
            </div>
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
