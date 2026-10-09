import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../../../.storybook/modes';
import { Button } from '../button/Button';
import { Input } from '../input/Input';
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    DialogTrigger,
} from './Dialog';

const meta = { title: 'Components/Dialog', component: Dialog } satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
    render: () => (
        <Dialog defaultOpen>
            <DialogTrigger asChild>
                <Button variant="secondary">Change owner</Button>
            </DialogTrigger>
            <DialogContent>
                <DialogTitle>Change owner?</DialogTitle>
                <DialogDescription>
                    This moves Dana Reyes out of Kate's portfolio. Kate will no longer see this record.
                </DialogDescription>
                <DialogBody>
                    <label className="grid gap-1">
                        New owner
                        <Input defaultValue="Sam O." />
                    </label>
                </DialogBody>
                <DialogFooter>
                    <Button variant="secondary">Cancel</Button>
                    <Button>Change owner</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    ),
};
export const OpenDark: Story = inMode(Open, 'dark');
export const OpenCompact: Story = inMode(Open, 'compact');

export const Closed: Story = {
    render: () => (
        <Dialog>
            <DialogTrigger asChild>
                <Button variant="secondary">Change owner</Button>
            </DialogTrigger>
            <DialogContent>
                <DialogTitle>Change owner?</DialogTitle>
            </DialogContent>
        </Dialog>
    ),
};
