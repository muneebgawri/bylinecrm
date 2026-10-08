import type { Meta, StoryObj } from '@storybook/react-vite';
import { Building2, Plus, Search, User } from 'lucide-react';
import { inMode } from '../../../.storybook/modes';
import {
    Command,
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
    CommandShortcut,
} from './Command';

const meta = { title: 'Components/Command', component: Command } satisfies Meta<typeof Command>;
export default meta;
type Story = StoryObj<typeof meta>;

function Items() {
    return (
        <>
            <CommandInput placeholder="Search people, companies, deals… or type a command" />
            <CommandList>
                <CommandEmpty>Nothing matches.</CommandEmpty>
                <CommandGroup heading="People">
                    <CommandItem>
                        <User aria-hidden /> Dana Reyes <span className="text-text-muted">· Acme Corp</span>
                    </CommandItem>
                    <CommandItem>
                        <User aria-hidden /> Sam Ortiz
                    </CommandItem>
                </CommandGroup>
                <CommandGroup heading="Companies">
                    <CommandItem>
                        <Building2 aria-hidden /> Acme Corp
                    </CommandItem>
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Actions">
                    <CommandItem>
                        <Plus aria-hidden /> New deal
                        <CommandShortcut>⌘N</CommandShortcut>
                    </CommandItem>
                    <CommandItem>
                        <Search aria-hidden /> Go to pipeline
                        <CommandShortcut>G P</CommandShortcut>
                    </CommandItem>
                </CommandGroup>
            </CommandList>
        </>
    );
}

/** Inline, as it would sit inside a panel. */
export const Inline: Story = {
    render: () => (
        <div className="max-w-lg rounded-md border border-border">
            <Command>
                <Items />
            </Command>
        </div>
    ),
};
export const InlineDark: Story = inMode(Inline, 'dark');
export const InlineCompact: Story = inMode(Inline, 'compact');

/** The ⌘K palette as a dialog. */
export const Palette: Story = {
    render: () => (
        <CommandDialog defaultOpen>
            <Items />
        </CommandDialog>
    ),
};
export const PaletteDark: Story = inMode(Palette, 'dark');
