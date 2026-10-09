import type { Meta, StoryObj } from '@storybook/react-vite';
import { Archive, Mail, Pencil, Trash2 } from 'lucide-react';
import { inMode } from '../../../.storybook/modes';
import { Button } from '../button/Button';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from './DropdownMenu';

const meta = { title: 'Components/DropdownMenu', component: DropdownMenu } satisfies Meta<typeof DropdownMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
    render: () => (
        <div className="h-72">
            <DropdownMenu defaultOpen modal={false}>
                <DropdownMenuTrigger asChild>
                    <Button variant="secondary">Actions</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                    <DropdownMenuLabel>Dana Reyes</DropdownMenuLabel>
                    <DropdownMenuItem>
                        <Pencil aria-hidden /> Edit
                        <DropdownMenuShortcut>E</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuItem>
                        <Mail aria-hidden /> Email
                        <DropdownMenuShortcut>M</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuCheckboxItem checked>Pinned</DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem>
                        <Archive aria-hidden /> Archive
                    </DropdownMenuItem>
                    <DropdownMenuItem destructive>
                        <Trash2 aria-hidden /> Delete
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled>Merge (no duplicate found)</DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    ),
};
export const OpenDark: Story = inMode(Open, 'dark');
export const OpenCompact: Story = inMode(Open, 'compact');
