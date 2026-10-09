import { Button, Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, cn } from '@bylinecrm/ui';
import type { RecordObject } from '@bylinecrm/shared';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useState } from 'react';
import { messageFor } from '../routes/w/records/InlineEdit';
import { useSearch } from '../api/lists';
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
    onChange: (id: string | null) => Promise<unknown> | void;
    /** Told the name of a record when it is chosen, for a caller that shows it elsewhere. */
    onResolved?: ((id: string, title: string) => void) | undefined;
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
    onChange,
    onResolved,
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
    const shown = value ? (valueLabel ?? '…') : (clearLabel ?? '—');

    if (!canEdit) {
        return (
            <span className={cn('block px-1 text-[13px]', !value && 'text-text-faint', className)} title={reason}>
                {shown}
            </span>
        );
    }

    const choose = async (next: string | null) => {
        setOpen(false);
        setQ('');
        if (next === value) return;
        setPending(true);
        try {
            await onChange(next);
            setError(null);
        } catch (e) {
            setError(messageFor(e, `${object}Id`));
        } finally {
            setPending(false);
        }
    };

    return (
        <div className={cn('flex flex-col gap-0.5', className)}>
            <ResponsivePanel
                title={label}
                open={open}
                onOpenChange={(next) => {
                    setOpen(next);
                    if (!next) setQ('');
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
                    <CommandInput value={q} onValueChange={setQ} placeholder={`Search ${label.toLowerCase()}…`} />
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
