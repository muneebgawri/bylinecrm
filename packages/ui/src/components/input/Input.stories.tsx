import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../../../.storybook/modes';
import { Input, Textarea } from './Input';

const meta = { title: 'Components/Input', component: Input } satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
    render: () => (
        <div className="grid max-w-md gap-4">
            <label className="grid gap-1 text-sm">
                Email
                <Input type="email" placeholder="dana@acme.example" />
            </label>
            <label className="grid gap-1 text-sm">
                With value
                <Input defaultValue="Dana Reyes" />
            </label>
            <label className="grid gap-1 text-sm">
                Invalid
                <Input aria-invalid defaultValue="not an email" aria-describedby="email-error" />
                <span id="email-error" className="text-xs text-danger">
                    Enter an address with an @.
                </span>
            </label>
            <label className="grid gap-1 text-sm">
                Disabled
                <Input disabled defaultValue="Read only" />
            </label>
            <label className="grid gap-1 text-sm">
                Note
                <Textarea placeholder="Met at FinCon…" />
            </label>
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
