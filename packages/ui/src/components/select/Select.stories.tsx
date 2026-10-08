import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../../../.storybook/modes';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from './Select';

const meta = { title: 'Components/Select', component: Select } satisfies Meta<typeof Select>;
export default meta;
type Story = StoryObj<typeof meta>;

const stages = ['New', 'Contacted', 'Replied', 'Meeting', 'Won'];

export const Gallery: Story = {
    render: () => (
        <div className="grid max-w-xs gap-4">
            <Select defaultValue="Replied">
                <SelectTrigger aria-label="Stage">
                    <SelectValue placeholder="Stage" />
                </SelectTrigger>
                <SelectContent>
                    {stages.map((s) => (
                        <SelectItem key={s} value={s}>
                            {s}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <Select>
                <SelectTrigger aria-label="Owner">
                    <SelectValue placeholder="Choose an owner" />
                </SelectTrigger>
                <SelectContent>
                    <SelectGroup>
                        <SelectLabel>Account managers</SelectLabel>
                        <SelectItem value="kate">Kate M.</SelectItem>
                        <SelectItem value="sam">Sam O.</SelectItem>
                    </SelectGroup>
                </SelectContent>
            </Select>
            <Select disabled defaultValue="New">
                <SelectTrigger aria-label="Disabled">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="New">New</SelectItem>
                </SelectContent>
            </Select>
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');

/** The list open, so the gates see the popover surface and its highlighted item. */
export const Open: Story = {
    render: () => (
        <div className="h-72 max-w-xs">
            <Select defaultValue="Replied" open>
                <SelectTrigger aria-label="Stage">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {stages.map((s) => (
                        <SelectItem key={s} value={s}>
                            {s}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    ),
};
export const OpenDark: Story = inMode(Open, 'dark');
