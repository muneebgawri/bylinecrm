import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { inMode } from '../../../.storybook/modes';
import { Toaster, ToastStore } from './Toast';

const meta = { title: 'Feedback/Toast', component: Toaster } satisfies Meta<typeof Toaster>;
export default meta;
type Story = StoryObj;

/** The gates screenshot the viewport, so the store is filled on mount and the toasts never expire. */
function Filled() {
    const [store] = useState(() => new ToastStore());
    useEffect(() => {
        store.push({
            title: 'Deal moved',
            description: 'Series B PR is now in Contacted',
            tone: 'success',
            durationMs: Infinity,
        });
        store.push({
            title: 'Move refused',
            description: 'You no longer own this deal. It stays in Replied.',
            tone: 'danger',
            durationMs: Infinity,
        });
        store.push({ title: 'Link copied', durationMs: Infinity });
    }, [store]);
    return (
        <div className="relative h-[300px]">
            <Toaster store={store} />
        </div>
    );
}

export const Gallery: Story = { render: () => <Filled /> };
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
