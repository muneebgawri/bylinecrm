import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../../../.storybook/modes';
import { Switch } from '../switch/Switch';
import { Checkbox } from './Checkbox';

const meta = { title: 'Components/Checkbox & Switch', component: Checkbox } satisfies Meta<typeof Checkbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
    render: () => (
        <div className="grid gap-4 text-sm">
            <label className="flex items-center gap-2">
                <Checkbox /> Unchecked
            </label>
            <label className="flex items-center gap-2">
                <Checkbox defaultChecked /> Checked
            </label>
            <label className="flex items-center gap-2">
                <Checkbox checked="indeterminate" /> Some selected
            </label>
            <label className="flex items-center gap-2">
                <Checkbox disabled defaultChecked /> Disabled
            </label>
            <label className="flex items-center gap-2">
                <Switch /> Off
            </label>
            <label className="flex items-center gap-2">
                <Switch defaultChecked /> On
            </label>
            <label className="flex items-center gap-2">
                <Switch disabled /> Disabled
            </label>
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
