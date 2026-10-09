import type { Meta, StoryObj } from '@storybook/react-vite';
import { ListTodo, MoreHorizontal, Send, StickyNote } from 'lucide-react';
import { inMode } from '../../../.storybook/modes';
import { BottomActionBar, BottomActionBarItem } from './BottomActionBar';

const meta = { title: 'Shell/BottomActionBar', component: BottomActionBar } satisfies Meta<typeof BottomActionBar>;
export default meta;
type Story = StoryObj;

/**
 * The bar renders only below the phone breakpoint; the gallery forces it on (`md:flex`) inside a
 * phone-width frame so the gates see it at the stories' desktop viewport.
 */
export const Gallery: Story = {
    render: () => (
        <div className="w-[375px] border border-border">
            <div className="h-40 p-4 text-sm text-text-muted">Record content scrolls above the bar.</div>
            <BottomActionBar label="Dana Reyes actions" className="md:flex">
                <BottomActionBarItem icon={<StickyNote aria-hidden />}>Note</BottomActionBarItem>
                <BottomActionBarItem icon={<ListTodo aria-hidden />}>Task</BottomActionBarItem>
                <BottomActionBarItem icon={<Send aria-hidden />} primary aria-disabled="true">
                    Enrol
                </BottomActionBarItem>
                <BottomActionBarItem icon={<MoreHorizontal aria-hidden />}>More</BottomActionBarItem>
            </BottomActionBar>
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
