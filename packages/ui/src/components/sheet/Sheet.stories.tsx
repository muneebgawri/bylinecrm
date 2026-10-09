import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../../../.storybook/modes';
import { Button } from '../button/Button';
import { Field } from '../field/Field';
import { Input } from '../input/Input';
import { Sheet, SheetContent, SheetTrigger } from './Sheet';

const meta = { title: 'Primitives/Sheet', component: SheetContent } satisfies Meta<typeof SheetContent>;
export default meta;
// Galleries render their own content; the story takes no args of its own.
type Story = StoryObj;

/** The phone's form of a popover: the visual gate photographs it open. */
export const Gallery: Story = {
    render: () => (
        <Sheet defaultOpen>
            <SheetTrigger asChild>
                <Button>Filter</Button>
            </SheetTrigger>
            <SheetContent
                title="Filter people"
                footer={
                    <>
                        <Button shape="square" className="flex-1">
                            Clear
                        </Button>
                        <Button shape="square" variant="primary" className="flex-1">
                            Show results
                        </Button>
                    </>
                }
            >
                <div className="flex flex-col gap-3">
                    <Field label="Job title contains">
                        <Input defaultValue="Head of" />
                    </Field>
                    <Field label="City is">
                        <Input defaultValue="Austin" />
                    </Field>
                </div>
            </SheetContent>
        </Sheet>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
