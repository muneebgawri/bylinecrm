import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@bylinecrm/ui';
import { useId, type ReactNode } from 'react';

export interface SelectFieldOption<V extends string> {
    value: V;
    label: string;
    /** Drawn before the label in the list and on the trigger (a stage colour's swatch). */
    leading?: ReactNode;
}

/**
 * A labelled one-of-many for the settings forms. Radix's Select root renders no element for a
 * `<label for>` to point at, so the label names the trigger through `aria-label` — the pattern
 * the other settings dialogs use — and is shown above it like every other field.
 */
export function SelectField<V extends string>({
    label,
    value,
    onValueChange,
    options,
    placeholder,
    hint,
}: {
    label: string;
    value: V | undefined;
    onValueChange: (value: V) => void;
    options: readonly SelectFieldOption<V>[];
    placeholder?: string;
    hint?: ReactNode;
}) {
    const hintId = useId();
    return (
        <div className="flex flex-col gap-1.5">
            <span aria-hidden className="text-[13px] font-medium text-text">
                {label}
            </span>
            <Select value={value ?? ''} onValueChange={(next) => onValueChange(next as V)}>
                <SelectTrigger aria-label={label} aria-describedby={hint ? hintId : undefined}>
                    <SelectValue placeholder={placeholder ?? 'Choose…'} />
                </SelectTrigger>
                <SelectContent>
                    {options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                            <span className="inline-flex items-center gap-2">
                                {option.leading}
                                {option.label}
                            </span>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {hint && (
                <p id={hintId} className="m-0 text-xs text-text-muted">
                    {hint}
                </p>
            )}
        </div>
    );
}

/** A switch with its sentence beside it; the whole row is the target (FR-CRMS-UI-12). */
export function SwitchRow({
    label,
    hint,
    checked,
    onCheckedChange,
}: {
    label: string;
    hint?: ReactNode;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
}) {
    const id = useId();
    return (
        <div className="flex items-start gap-3 max-md:min-h-touch">
            <Switch
                id={id}
                checked={checked}
                onCheckedChange={onCheckedChange}
                aria-describedby={hint ? `${id}-hint` : undefined}
            />
            <div className="grid gap-0.5 text-sm">
                {/* The label names the switch; the hint describes it — inside the label it would join the name. */}
                <label htmlFor={id} className="font-medium">
                    {label}
                </label>
                {hint && (
                    <span id={`${id}-hint`} className="text-xs text-text-muted">
                        {hint}
                    </span>
                )}
            </div>
        </div>
    );
}
