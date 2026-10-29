import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandShortcut,
    commandFilter,
    isStringArray,
    usePersistedState,
} from '@bylinecrm/ui';
import type { RecordObject } from '@bylinecrm/shared';
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useSearch } from '../api/lists';
import type { SearchResults } from '../api/types';
import { useCommands, type Command } from '../commands/registry';
import { useDebounced } from '../lib/useDebounced';
import { paths } from '../routes/paths';
import { formatShortcut } from '../commands/shortcuts';
import { PALETTE_RECENTS_KEY, PALETTE_RECENTS_LIMIT } from './storage';

/**
 * The palette's groups in display order (mockup v3); a command's `group` must be one of these. The
 * record in front (a drawer, else the page) lists its own actions first — "Email this person",
 * "Add a note" — under `useRecordCommands`' groups.
 */
export const PALETTE_GROUPS = ['Suggested', 'This panel', 'This record', 'Go to', 'Create', 'Account'] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

/** How many matches the palette lists per object; more typing narrows, it never pages. */
const PALETTE_RESULTS = 5;
const RECORD_GROUPS: readonly { object: RecordObject; heading: string }[] = [
    { object: 'person', heading: 'People' },
    { object: 'company', heading: 'Companies' },
    { object: 'opportunity', heading: 'Deals' },
];
const RECORD_OBJECTS = RECORD_GROUPS.map((g) => g.object);
/** A record hit's cmdk value starts with this: the server matched it, so the palette's own filter never hides it. */
const RECORD_VALUE = 'record:';

/**
 * Records rank first — the server already matched them, on names, emails and domains the palette cannot
 * see — so Enter opens the best one; commands keep cmdk's fuzzy match.
 */
function paletteFilter(value: string, search: string, keywords?: string[]): number {
    return value.startsWith(RECORD_VALUE) ? 1 : commandFilter(value, search, keywords);
}
type SearchHit = SearchResults[RecordObject][number];

export interface CommandPaletteProps {
    workspaceId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/**
 * ⌘K. Lists the records matching what is typed (`GET /search`, as `RecordPicker` does), then every
 * available registered command grouped as `PALETTE_GROUPS` orders them; "Suggested" is the
 * commands run most recently (persisted per viewer). Enter runs, Esc closes.
 */
export function CommandPalette({ workspaceId, open, onOpenChange }: CommandPaletteProps) {
    const all = useCommands();
    const navigate = useNavigate();
    const [q, setQ] = useState('');
    const term = useDebounced(q);
    const results = useSearch(workspaceId, open ? term : '', RECORD_OBJECTS, PALETTE_RESULTS);
    // The hits arrive after typing has settled, when cmdk has already highlighted a command: the best
    // record the caller may open is highlighted instead, so Enter opens it.
    const [highlighted, setHighlighted] = useState('');
    const [answered, setAnswered] = useState(results.data);
    if (results.data !== answered) {
        setAnswered(results.data);
        const best = RECORD_OBJECTS.flatMap((object) => results.data?.[object] ?? []).find((hit) => hit.canOpen);
        if (best) setHighlighted(hitValue(best));
    }
    const [recents, setRecents] = usePersistedState<string[]>(PALETTE_RECENTS_KEY, isStringArray, []);

    const available = useMemo(() => all.filter((c) => c.when?.() ?? true), [all]);
    const byId = useMemo(() => new Map(available.map((c) => [c.id, c])), [available]);
    const suggested = recents.map((id) => byId.get(id)).filter((c): c is Command => Boolean(c));
    const groups = PALETTE_GROUPS.filter((g) => g !== 'Suggested').map((group) => ({
        group,
        commands: available.filter((c) => c.group === group),
    }));

    // A command runs once the palette has closed and let go of focus, so one that moves focus (into
    // the composer, onto the owner field) keeps it instead of having it handed back to the trigger.
    const chosen = useRef<Command | null>(null);
    const close = (next: boolean) => {
        if (!next) setQ('');
        onOpenChange(next);
    };
    const run = (command: Command) => {
        chosen.current = command;
        setRecents((current) =>
            [command.id, ...current.filter((id) => id !== command.id)].slice(0, PALETTE_RECENTS_LIMIT),
        );
        close(false);
    };
    const openHit = (hit: SearchHit) => {
        chosen.current = {
            id: `record.${hit.id}`,
            title: hit.title,
            group: 'Records',
            run: () => navigate(hitPath(workspaceId, hit)),
        };
        close(false);
    };

    return (
        <CommandDialog
            open={open}
            onOpenChange={close}
            filter={paletteFilter}
            value={highlighted}
            onValueChange={setHighlighted}
            onCloseAutoFocus={(event) => {
                const command = chosen.current;
                if (!command) return;
                chosen.current = null;
                event.preventDefault();
                command.run();
            }}
        >
            <CommandInput placeholder="Search for a page, a record or an action…" value={q} onValueChange={setQ} />
            <CommandList>
                <CommandEmpty>{results.isFetching ? 'Searching…' : 'Nothing matches.'}</CommandEmpty>
                {q.trim() !== '' &&
                    RECORD_GROUPS.map(({ object, heading }) => {
                        const hits = results.data?.[object] ?? [];
                        return (
                            hits.length > 0 && (
                                <CommandGroup key={object} heading={heading}>
                                    {hits.map((hit) => (
                                        <CommandItem
                                            key={hit.id}
                                            value={hitValue(hit)}
                                            // Someone else's, outside the caller's scope: shown so they see it is taken,
                                            // by name and owner only, and not opened.
                                            disabled={!hit.canOpen}
                                            onSelect={() => openHit(hit)}
                                        >
                                            <span className="flex min-w-0 flex-col">
                                                <span className="truncate">{hit.title}</span>
                                                {hit.canOpen ? (
                                                    hit.subtitle && (
                                                        <span className="truncate text-xs text-text-faint">
                                                            {hit.subtitle}
                                                        </span>
                                                    )
                                                ) : (
                                                    <span className="truncate text-xs text-text-faint">
                                                        Already taken: not yours to open
                                                    </span>
                                                )}
                                            </span>
                                            <span className="ml-auto shrink-0 pl-3 text-xs text-text-muted">
                                                {ownerLabel(hit.owner)}
                                            </span>
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            )
                        );
                    })}
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

function hitValue(hit: SearchHit): string {
    return `${RECORD_VALUE}${hit.object}:${hit.id}`;
}

function hitPath(workspaceId: string, hit: SearchHit): string {
    switch (hit.object) {
        case 'person':
            return paths.person(workspaceId, hit.id);
        case 'company':
            return paths.company(workspaceId, hit.id);
        case 'opportunity':
            return paths.deal(workspaceId, hit.id);
    }
}

/** Whose record it is, as the palette says it beside each hit. */
function ownerLabel(owner: SearchHit['owner']): string {
    if (!owner) return 'No owner';
    const name = owner.name ?? 'Unnamed member';
    return owner.leftAt ? `Owner: ${name} (left)` : `Owner: ${name}`;
}
