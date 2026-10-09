import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../../../.storybook/modes';
import { Button } from '../button/Button';
import { Field } from '../field/Field';
import { Input } from '../input/Input';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';

const meta = { title: 'Primitives/Popover', component: PopoverContent } satisfies Meta<typeof PopoverContent>;
export default meta;
// Galleries render their own content; the story takes no args of its own.
type Story = StoryObj;

/** The visual gate photographs the open panel; the story opens it by default. */
export const Gallery: Story = {
    render: () => (
        <div className="h-64">
            <Popover defaultOpen>
                <PopoverTrigger asChild>
                    <Button shape="square">Filter</Button>
                </PopoverTrigger>
                <PopoverContent className="w-80" aria-label="Filter">
                    <div className="flex flex-col gap-3">
                        <Field label="Job title contains">
                            <Input defaultValue="Head of" />
                        </Field>
                        <div className="flex justify-end gap-2">
                            <Button size="sm" shape="square">
                                Clear
                            </Button>
                            <Button size="sm" shape="square" variant="primary">
                                Apply
                            </Button>
                        </div>
                    </div>
                </PopoverContent>
            </Popover>
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
