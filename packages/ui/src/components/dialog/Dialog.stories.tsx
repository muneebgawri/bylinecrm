import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../../../.storybook/modes';
import { Button } from '../button/Button';
import { Checkbox } from '../checkbox/Checkbox';
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

/**
 * A dialog taller than the window — a form whose body and footer are both inside `<form>`, as the role editor's
 * is (bylinecrm#271). The panel scrolls inside itself and its footer stays in view, so the submit is never
 * off-screen. The layout gate (gates/layout.spec.ts) opens this story in short windows.
 */
const PERMISSIONS = Array.from({ length: 30 }, (_, i) => `Permission ${i + 1}`);
export const Tall: Story = {
    render: () => (
        <Dialog defaultOpen>
            <DialogTrigger asChild>
                <Button variant="secondary">New role</Button>
            </DialogTrigger>
            <DialogContent>
                <DialogTitle>New role</DialogTitle>
                <DialogDescription>Pick what members with this role may do.</DialogDescription>
                <form onSubmit={(e) => e.preventDefault()}>
                    <DialogBody className="grid gap-1">
                        {PERMISSIONS.map((label) => (
                            <label key={label} className="flex items-center gap-2 py-1">
                                <Checkbox />
                                {label}
                            </label>
                        ))}
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" variant="secondary">
                            Cancel
                        </Button>
                        <Button type="submit">Create role</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    ),
};

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
