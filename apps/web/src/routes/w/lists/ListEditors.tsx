import { SORT_MAX_FIELDS, type FieldDescriptor, type ViewSort } from '@bylinecrm/shared';
import {
    Button,
    Checkbox,
    SegmentedControl,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@bylinecrm/ui';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';

/**
 * The sort editor: up to `SORT_MAX_FIELDS` fields, each ascending or descending, in priority
 * order. The fields offered are the sortable ones the shared descriptors name — nothing else.
 */
export function SortEditor({
    fields,
    value,
    onChange,
}: {
    fields: readonly FieldDescriptor[];
    value: readonly ViewSort[];
    onChange: (next: ViewSort[]) => void;
}) {
    const sortable = fields.filter((f) => f.sortable);
    const unused = sortable.filter((f) => !value.some((s) => s.field === f.name));
    const set = (index: number, sort: ViewSort | null) =>
        onChange(sort === null ? value.filter((_, i) => i !== index) : value.map((s, i) => (i === index ? sort : s)));

    return (
        <div className="flex flex-col gap-2.5">
            {value.length === 0 && <p className="m-0 text-[13px] text-text-muted">Newest first, unless you choose.</p>}
            {value.map((sort, index) => (
                <div key={sort.field} className="flex flex-wrap items-center gap-2">
                    <span className="w-14 text-[13px] text-text-muted">{index === 0 ? 'Sort by' : 'then by'}</span>
                    <div className="min-w-40 flex-1">
                        <Select value={sort.field} onValueChange={(field) => set(index, { ...sort, field })}>
                            <SelectTrigger aria-label={`Sort field ${index + 1}`}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {sortable
                                    .filter((f) => f.name === sort.field || !value.some((s) => s.field === f.name))
                                    .map((f) => (
                                        <SelectItem key={f.name} value={f.name}>
                                            {f.label}
                                        </SelectItem>
                                    ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <SegmentedControl
                        aria-label={`Direction ${index + 1}`}
                        value={sort.direction}
                        onValueChange={(direction) => set(index, { ...sort, direction })}
                        options={[
                            { value: 'asc', label: 'A→Z' },
                            { value: 'desc', label: 'Z→A' },
                        ]}
                    />
                    <Button
                        size="icon"
                        shape="square"
                        variant="ghost"
                        aria-label="Remove sort"
                        onClick={() => set(index, null)}
                    >
                        <X aria-hidden />
                    </Button>
                </div>
            ))}
            {value.length < SORT_MAX_FIELDS && unused[0] && (
                <Button
                    size="sm"
                    shape="square"
                    className="self-start"
                    onClick={() => unused[0] && onChange([...value, { field: unused[0].name, direction: 'asc' }])}
                >
                    <Plus aria-hidden /> Add sort
                </Button>
            )}
        </div>
    );
}

export interface ColumnChoice {
    field: string;
    label: string;
    visible: boolean;
    /** The identity column: always shown, always first. */
    locked: boolean;
}

/**
 * Show, hide and reorder columns. Order changes with up/down buttons — keyboard-complete, and a
 * reorder a screen reader can follow — rather than drag alone.
 */
export function ColumnChooser({
    choices,
    onChange,
}: {
    choices: readonly ColumnChoice[];
    onChange: (next: ColumnChoice[]) => void;
}) {
    const move = (index: number, by: -1 | 1) => {
        const target = index + by;
        const other = choices[target];
        const self = choices[index];
        if (!other || !self || other.locked) return;
        const next = [...choices];
        next[index] = other;
        next[target] = self;
        onChange(next);
    };
    return (
        <ul className="m-0 flex max-h-96 list-none flex-col gap-0.5 overflow-y-auto p-0">
            {choices.map((choice, index) => (
                <li
                    key={choice.field}
                    className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-surface-raised"
                >
                    <label className="flex flex-1 items-center gap-2 text-sm">
                        <Checkbox
                            checked={choice.visible}
                            disabled={choice.locked}
                            onCheckedChange={(on) =>
                                onChange(
                                    choices.map((c) => (c.field === choice.field ? { ...c, visible: on === true } : c)),
                                )
                            }
                        />
                        {choice.label}
                    </label>
                    {!choice.locked && (
                        <>
                            <Button
                                size="xs"
                                shape="square"
                                variant="ghost"
                                aria-label={`Move ${choice.label} up`}
                                disabled={index <= 1}
                                onClick={() => move(index, -1)}
                            >
                                <ArrowUp aria-hidden />
                            </Button>
                            <Button
                                size="xs"
                                shape="square"
                                variant="ghost"
                                aria-label={`Move ${choice.label} down`}
                                disabled={index === choices.length - 1}
                                onClick={() => move(index, 1)}
                            >
                                <ArrowDown aria-hidden />
                            </Button>
                        </>
                    )}
                </li>
            ))}
        </ul>
    );
}
