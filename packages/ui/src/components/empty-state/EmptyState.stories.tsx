import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlertTriangle, Inbox } from 'lucide-react';
import { inMode } from '../../../.storybook/modes';
import { Button } from '../button/Button';
import { EmptyState } from './EmptyState';

const meta = { title: 'Components/EmptyState', component: EmptyState } satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj;

/** "Nothing here" and "could not load" are different states and look different (FR-CRMS-UI-7). */
export const Gallery: Story = {
    render: () => (
        <div className="grid max-w-2xl gap-6">
            <EmptyState
                icon={<Inbox />}
                title="No deals in this view"
                body="Create a deal, or clear the filter to see every deal you own."
                action={<Button>New deal</Button>}
            />
            <EmptyState
                tone="error"
                icon={<AlertTriangle />}
                title="Couldn't load deals"
                body="The server did not answer. Your filter and view are unchanged."
                action={<Button variant="secondary">Retry</Button>}
            />
            <EmptyState title="0 deals match" body="Your filter excludes everything. Clear it to see all 30 deals." />
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
