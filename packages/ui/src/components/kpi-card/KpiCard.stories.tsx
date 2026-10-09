import type { Meta, StoryObj } from '@storybook/react-vite';
import { CalendarCheck, Handshake, Inbox, Reply } from 'lucide-react';
import { inMode } from '../../../.storybook/modes';
import { Badge } from '../badge/Badge';
import { Delta } from '../delta/Delta';
import { KpiCard } from './KpiCard';

const meta = { title: 'Shell/KpiCard', component: KpiCard } satisfies Meta<typeof KpiCard>;
export default meta;
// Galleries render their own content; the story takes no args of its own.
type Story = StoryObj;

const Spark = () => (
    <svg viewBox="0 0 84 26" aria-hidden>
        <polyline
            points="0,20 12,16 24,18 36,10 48,12 60,6 72,9 84,4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
        />
    </svg>
);

export const Gallery: Story = {
    render: () => (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
            <KpiCard
                icon={<Reply />}
                tone="success"
                label="Reply rate"
                value="4.2%"
                delta={<Delta direction="up">0.8</Delta>}
                footnote="9 of 212 sent this week"
                sparkline={<Spark />}
            />
            <KpiCard
                icon={<Handshake />}
                label="Open deals"
                value="14"
                delta={<Delta direction="up">2</Delta>}
                footnote="$61.5k weighted"
            />
            <KpiCard
                icon={<CalendarCheck />}
                tone="info"
                label="Meetings booked"
                value="3"
                delta={<Delta direction="down">1</Delta>}
                footnote="next Thu 10:00 · Initech"
            />
            <KpiCard
                icon={<Inbox />}
                tone="warning"
                label="Sending pool"
                value="162"
                delta={<span className="text-base font-normal text-text-muted">/ 200</span>}
                footnote={
                    <>
                        <Badge status="warning">1 paused</Badge> 5 of 6 mailboxes active
                    </>
                }
            />
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
