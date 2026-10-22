import {
    Button,
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    cn,
    toast,
} from '@bylinecrm/ui';
import type { RecordObject } from '@bylinecrm/shared';
import { Check, ChevronsUpDown, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { messageFor } from '../routes/w/records/InlineEdit';
import { ApiError } from '../api/client';
import { useSearch } from '../api/lists';
import { failureText } from '../lib/errors';
import { useDebounced } from '../lib/useDebounced';
import { ResponsivePanel } from './ResponsivePanel';

/** How many matches a picker lists; more typing narrows, it never pages. */
const PICKER_RESULTS = 10;

export interface RecordPickerProps {
    workspaceId: string;
    object: RecordObject;
    value: string | null;
    /** The chosen record's name, when the page already knows it; shown on the trigger. */
    valueLabel?: string | null | undefined;
    /** The field's name: the trigger's accessible label and the panel's heading. */
    label: string;
    /** The choice that clears the field ("No company"); absent when the field is required. */
    clearLabel?: string | undefined;
    /** What the trigger says while nothing is chosen ("Add a person"); the clear choice's words otherwise. */
    placeholder?: string | undefined;
    onChange: (id: string | null) => Promise<unknown> | void;
    /** Told the name of a record when it is chosen, for a caller that shows it elsewhere. */
    onResolved?: ((id: string, title: string) => void) | undefined;
    /**
     * Makes a new record named as typed, offered as `Create <label> "<typed>"` when no match has that name;
     * absent (the member may not create one), nothing is offered. Resolves the new record, which is then chosen.
     */
    onCreate?: ((name: string) => Promise<{ id: string; title: string }>) | undefined;
    canEdit?: boolean;
    /** Why editing is not offered (FR-CRMS-UI-6). */
    reason?: string | undefined;
    id?: string | undefined;
    className?: string | undefined;
}

/**
 * Picks one company, person or deal by searching for it (`GET /search`), not by loading a list: it
 * works the same with ten records or a hundred thousand. Desktop: a popover; phone: a sheet.
 * The one record picker — owner/company/contact fields and the filter builder use it.
 */
export function RecordPicker({
    workspaceId,
    object,
    value,
    valueLabel,
    label,
    clearLabel,
    placeholder,
    onChange,
    onResolved,
    onCreate,
    canEdit = true,
    reason,
    id,
    className,
}: RecordPickerProps) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const term = useDebounced(q);
    const results = useSearch(workspaceId, open ? term : '', [object], PICKER_RESULTS);
    const hits = results.data?.[object] ?? [];
    const shown = value ? (valueLabel ?? '…') : (placeholder ?? clearLabel ?? '—');
    /** A record the API named when a create was refused as a duplicate (a company already at that domain). */
    const [existing, setExisting] = useState<{ id: string; title: string } | null>(null);
    const [creating, setCreating] = useState(false);
    const typed = term.trim();
    const noun = label.toLowerCase();
    // Offered once the search for what was typed has answered, and only when nothing found has that name.
    const offerCreate =
        onCreate !== undefined &&
        typed !== '' &&
        typed === q.trim() &&
        results.data !== undefined &&
        !results.isFetching &&
        !hits.some((hit) => hit.title.trim().toLowerCase() === typed.toLowerCase());

    if (!canEdit) {
        return (
            <span className={cn('block px-1 text-[13px]', !value && 'text-text-faint', className)} title={reason}>
                {shown}
            </span>
        );
    }

    const choose = async (next: string | null): Promise<boolean> => {
        setOpen(false);
        setQ('');
        setExisting(null);
        if (next === value) return true;
        setPending(true);
        try {
            await onChange(next);
            setError(null);
            return true;
        } catch (e) {
            setError(messageFor(e, `${object}Id`));
            return false;
        } finally {
            setPending(false);
        }
    };

    /** Creates the record and chooses it; a refusal keeps the picker open with the API's words in a toast. */
    const create = async (name: string) => {
        if (!onCreate || creating) return;
        setCreating(true);
        let created: { id: string; title: string };
        try {
            created = await onCreate(name);
        } catch (e) {
            const companyId = e instanceof ApiError ? e.details['companyId'] : undefined;
            if (e instanceof ApiError && e.code === 'conflict.company_owned' && typeof companyId === 'string') {
                // Another company already has this one's domain: offer that one rather than make a twin.
                const companyName = String(e.details['companyName'] ?? 'Another company');
                setExisting({ id: companyId, title: companyName });
                toast({
                    tone: 'danger',
                    title: `${companyName} already has that domain.`,
                    description: 'Choose it instead.',
                });
            } else {
                toast({ tone: 'danger', title: `Could not create ${noun} “${name}”.`, description: failureText(e) });
            }
            return;
        } finally {
            setCreating(false);
        }
        onResolved?.(created.id, created.title);
        if (await choose(created.id)) toast({ tone: 'success', title: `Created ${noun} “${created.title}”.` });
    };

    return (
        <div className={cn('flex flex-col gap-0.5', className)}>
            <ResponsivePanel
                title={label}
                open={open}
                onOpenChange={(next) => {
                    setOpen(next);
                    if (!next) {
                        setQ('');
                        setExisting(null);
                    }
                }}
                widthClass="w-[min(22rem,calc(100vw-2rem))]"
                trigger={
                    <Button
                        id={id}
                        size="sm"
                        shape="square"
                        variant="ghost"
                        loading={pending}
                        aria-label={`${label}: ${shown}`}
                        className="h-7 w-full justify-between px-2 text-[13px] font-normal text-text"
                    >
                        <span className={cn('truncate', !value && 'text-text-faint')}>{shown}</span>
                        <ChevronsUpDown aria-hidden />
                    </Button>
                }
            >
                <Command shouldFilter={false} className="bg-surface" label={`Search ${label.toLowerCase()}`}>
                    <CommandInput
                        value={q}
                        onValueChange={(next) => {
                            setQ(next);
                            setExisting(null);
                        }}
                        placeholder={`Search ${label.toLowerCase()}…`}
                    />
                    <CommandList>
                        {term.trim() === '' ? (
                            <p className="m-0 px-2 py-4 text-center text-sm text-text-muted">Type to search.</p>
                        ) : (
                            <CommandEmpty>{results.isFetching ? 'Searching…' : 'No matches.'}</CommandEmpty>
                        )}
                        {clearLabel && value && (
                            <CommandGroup>
                                <CommandItem value="__clear__" onSelect={() => void choose(null)}>
                                    <X aria-hidden />
                                    {clearLabel}
                                </CommandItem>
                            </CommandGroup>
                        )}
                        {hits.length > 0 && (
                            <CommandGroup heading="Matches">
                                {hits.map((hit) => (
                                    <CommandItem
                                        key={hit.id}
                                        value={hit.id}
                                        onSelect={() => {
                                            onResolved?.(hit.id, hit.title);
                                            void choose(hit.id);
                                        }}
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate">{hit.title}</span>
                                            {hit.subtitle && (
                                                <span className="block truncate text-xs text-text-muted">
                                                    {hit.subtitle}
                                                </span>
                                            )}
                                        </span>
                                        {hit.id === value && <Check aria-hidden />}
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        )}
                        {existing && (
                            <CommandGroup heading="Already has that domain">
                                <CommandItem
                                    value={`__existing__${existing.id}`}
                                    onSelect={() => {
                                        onResolved?.(existing.id, existing.title);
                                        void choose(existing.id);
                                    }}
                                >
                                    <span className="min-w-0 flex-1 truncate">{existing.title}</span>
                                    {existing.id === value && <Check aria-hidden />}
                                </CommandItem>
                            </CommandGroup>
                        )}
                        {offerCreate && (
                            <CommandGroup>
                                <CommandItem value="__create__" disabled={creating} onSelect={() => void create(typed)}>
                                    <Plus aria-hidden />
                                    <span className="min-w-0 flex-1 truncate">
                                        Create {noun} "{typed}"
                                    </span>
                                </CommandItem>
                            </CommandGroup>
                        )}
                    </CommandList>
                </Command>
            </ResponsivePanel>
            {error && (
                <p role="alert" className="m-0 px-1 text-xs text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}
