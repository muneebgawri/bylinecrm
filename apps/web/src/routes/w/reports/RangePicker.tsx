import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Input,
    cn,
} from '@bylinecrm/ui';
import { CalendarDays, Check, ChevronDown } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { RANGE_PRESETS, presetRange, rangeLabel, toDateInput, type DateRange, type RangePreset } from './reportsData';

export type RangeChoice = { preset: RangePreset } | { custom: DateRange };

export function rangeOf(choice: RangeChoice): DateRange {
    return 'preset' in choice ? presetRange(choice.preset) : choice.custom;
}

/**
 * The period the reports read: a preset from the menu, or two dates. The button names the range
 * by its first and last day, as the template's does.
 */
export function RangePicker({ value, onChange }: { value: RangeChoice; onChange: (next: RangeChoice) => void }) {
    const range = rangeOf(value);
    const [custom, setCustom] = useState(false);
    const [from, setFrom] = useState(toDateInput(range.from));
    const [to, setTo] = useState(toDateInput(new Date(range.to.getTime() - 1)));
    const applyCustom = (event: FormEvent) => {
        event.preventDefault();
        const start = new Date(`${from}T00:00:00`);
        const last = new Date(`${to}T00:00:00`);
        if (Number.isNaN(start.getTime()) || Number.isNaN(last.getTime()) || last < start) return;
        onChange({ custom: { from: start, to: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1) } });
        setCustom(false);
    };
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" aria-label={`Period: ${rangeLabel(range)}`}>
                    <CalendarDays aria-hidden />
                    {rangeLabel(range)}
                    <ChevronDown aria-hidden className="size-3.5 text-text-muted" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-64 p-2">
                {RANGE_PRESETS.map((p) => {
                    const on = 'preset' in value && value.preset === p.id;
                    return (
                        <DropdownMenuItem key={p.id} onSelect={() => onChange({ preset: p.id })}>
                            <span className="flex-1">{p.label}</span>
                            {on && <Check aria-hidden className="size-4" />}
                        </DropdownMenuItem>
                    );
                })}
                <div className="my-1 h-px bg-border" />
                {custom ? (
                    <form onSubmit={applyCustom} className="flex flex-col gap-2 p-1">
                        <label className="flex flex-col gap-1 text-xs text-text-muted">
                            From
                            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8" />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-text-muted">
                            To
                            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8" />
                        </label>
                        <div className="flex justify-end gap-2 pt-1">
                            <Button type="button" variant="ghost" size="sm" onClick={() => setCustom(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" variant="primary" size="sm">
                                Apply
                            </Button>
                        </div>
                    </form>
                ) : (
                    <DropdownMenuItem
                        onSelect={(e) => {
                            e.preventDefault();
                            setCustom(true);
                        }}
                        className={cn('custom' in value && 'font-medium')}
                    >
                        <span className="flex-1">Custom range…</span>
                        {'custom' in value && <Check aria-hidden className="size-4" />}
                    </DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
