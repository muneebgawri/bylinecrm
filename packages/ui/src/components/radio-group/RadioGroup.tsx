import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { focusWithinRing } from '../../lib/focus';

export interface RadioOption<V extends string> {
    value: V;
    label: string;
    /** One line under the label that says what choosing it means. */
    description?: ReactNode;
    disabled?: boolean;
}

export interface RadioGroupProps<V extends string> {
    /** The question the choice answers; it names the group for assistive tech. */
    legend: string;
    options: readonly RadioOption<V>[];
    value: V;
    onValueChange: (value: V) => void;
    disabled?: boolean;
    className?: string;
}

/**
 * One choice of a few, each with a sentence that explains it — "All records / Only records they
 * own". Native radio inputs, so the arrow keys, the form and every screen reader behave as they
 * expect; the input is visually hidden and the whole row is the target, at least the touch-target
 * token tall on a phone (FR-CRMS-UI-12).
 */
export function RadioGroup<V extends string>({
    legend,
    options,
    value,
    onValueChange,
    disabled,
    className,
}: RadioGroupProps<V>) {
    const name = useId();
    return (
        <fieldset className={cn('m-0 grid gap-1.5 border-0 p-0', className)} disabled={disabled}>
            <legend className="mb-1.5 p-0 text-[13px] font-medium text-text">{legend}</legend>
            {options.map((option) => {
                const id = `${name}-${option.value}`;
                const checked = option.value === value;
                return (
                    <label
                        key={option.value}
                        htmlFor={id}
                        className={cn(
                            'flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2.5 transition-colors max-md:min-h-touch',
                            'hover:bg-surface-raised',
                            focusWithinRing,
                            checked && 'border-accent bg-accent-soft',
                            (disabled || option.disabled) && 'cursor-not-allowed opacity-50',
                        )}
                    >
                        <input
                            id={id}
                            type="radio"
                            name={name}
                            value={option.value}
                            checked={checked}
                            disabled={option.disabled}
                            onChange={() => onValueChange(option.value)}
                            className="peer sr-only"
                        />
                        <span
                            aria-hidden
                            className={cn(
                                'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-border-strong bg-surface',
                                checked && 'border-accent',
                            )}
                        >
                            {checked && <span className="size-2 rounded-full bg-accent" />}
                        </span>
                        <span className="grid gap-0.5">
                            <span className="text-sm font-medium text-text">{option.label}</span>
                            {option.description && (
                                <span className="text-xs text-text-muted">{option.description}</span>
                            )}
                        </span>
                    </label>
                );
            })}
        </fieldset>
    );
}
