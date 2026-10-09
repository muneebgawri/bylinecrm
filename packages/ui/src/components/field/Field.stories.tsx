import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../../../.storybook/modes';
import { Input, Textarea } from '../input/Input';
import { Field } from './Field';

const meta = { title: 'Components/Field', component: Field } satisfies Meta<typeof Field>;
export default meta;
// Galleries render their own content; the story takes no args of its own.
type Story = StoryObj;

export const Gallery: Story = {
    render: () => (
        <form className="flex max-w-sm flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
            <Field label="Email" required hint="We will send the invitation here.">
                <Input type="email" placeholder="name@company.com" />
            </Field>
            <Field label="Workspace name" error="A workspace needs a name.">
                <Input defaultValue="" />
            </Field>
            <Field label="Note">
                <Textarea rows={3} placeholder="Met at FinCon…" />
            </Field>
        </form>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
