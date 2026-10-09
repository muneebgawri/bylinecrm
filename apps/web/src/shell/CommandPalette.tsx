import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandShortcut,
    isStringArray,
    usePersistedState,
} from '@bylinecrm/ui';
import { useMemo } from 'react';
import { useCommands, type Command } from '../commands/registry';
import { formatShortcut } from '../commands/shortcuts';
import { PALETTE_RECENTS_KEY, PALETTE_RECENTS_LIMIT } from './storage';

/** The palette's groups in display order (mockup v3); a command's `group` must be one of these. */
export const PALETTE_GROUPS = ['Suggested', 'Go to', 'Create', 'Account'] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

export interface CommandPaletteProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/**
 * ⌘K. Lists every available registered command grouped Suggested / Go to / Create / Account;
 * "Suggested" is the commands run most recently (persisted per viewer). Enter runs, Esc closes.
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
    const all = useCommands();
    const [recents, setRecents] = usePersistedState<string[]>(PALETTE_RECENTS_KEY, isStringArray, []);

    const available = useMemo(() => all.filter((c) => c.when?.() ?? true), [all]);
    const byId = useMemo(() => new Map(available.map((c) => [c.id, c])), [available]);
    const suggested = recents.map((id) => byId.get(id)).filter((c): c is Command => Boolean(c));
    const groups = PALETTE_GROUPS.filter((g) => g !== 'Suggested').map((group) => ({
        group,
        commands: available.filter((c) => c.group === group),
    }));

    const run = (command: Command) => {
        onOpenChange(false);
        setRecents((current) =>
            [command.id, ...current.filter((id) => id !== command.id)].slice(0, PALETTE_RECENTS_LIMIT),
        );
        command.run();
    };

    return (
        <CommandDialog open={open} onOpenChange={onOpenChange}>
            <CommandInput placeholder="Search for a page, a record or an action…" />
            <CommandList>
                <CommandEmpty>Nothing matches.</CommandEmpty>
                {suggested.length > 0 && (
                    <CommandGroup heading="Suggested">
                        {suggested.map((command) => (
                            <Item key={`recent-${command.id}`} command={command} onRun={run} />
                        ))}
                    </CommandGroup>
                )}
                {groups.map(
                    ({ group, commands }) =>
                        commands.length > 0 && (
                            <CommandGroup key={group} heading={group}>
                                {commands.map((command) => (
                                    <Item key={command.id} command={command} onRun={run} />
                                ))}
                            </CommandGroup>
                        ),
                )}
            </CommandList>
            <div className="flex gap-4 border-t border-border px-4.5 py-2.5 text-xs text-text-faint">
                <span>↑↓ to move</span>
                <span>↵ to open</span>
                <span>esc to close</span>
            </div>
        </CommandDialog>
    );
}

function Item({ command, onRun }: { command: Command; onRun: (c: Command) => void }) {
    return (
        <CommandItem value={`${command.title} ${(command.keywords ?? []).join(' ')}`} onSelect={() => onRun(command)}>
            {command.title}
            {command.shortcut && <CommandShortcut>{formatShortcut(command.shortcut)}</CommandShortcut>}
        </CommandItem>
    );
}
