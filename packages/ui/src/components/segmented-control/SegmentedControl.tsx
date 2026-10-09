import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

export interface SegmentedOption<V extends string> {
    value: V;
    label: string;
    disabled?: boolean;
}

export interface SegmentedControlProps<V extends string> extends Omit<
    ComponentPropsWithoutRef<typeof ToggleGroup.Root>,
    'type' | 'value' | 'onValueChange' | 'defaultValue'
> {
    options: readonly SegmentedOption<V>[];
    value: V;
    onValueChange: (value: V) => void;
    /** The control's accessible name: "View", "Period". */
    'aria-label': string;
}

function SegmentedControlInner<V extends string>(
    { className, options, value, onValueChange, ...props }: SegmentedControlProps<V>,
    ref: React.ForwardedRef<ComponentRef<typeof ToggleGroup.Root>>,
) {
    return (
        <ToggleGroup.Root
            ref={ref}
            type="single"
            value={value}
            // Radix reports '' when the active item is clicked again; a segmented control always has one on.
            onValueChange={(next) => next && onValueChange(next as V)}
            className={cn('inline-flex gap-0.5 rounded-md border border-border bg-surface-raised p-0.75', className)}
            {...props}
        >
            {options.map((option) => (
                <ToggleGroup.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    className={cn(
                        'h-6.5 rounded-[6px] px-2.5 text-[13px] text-text-muted transition-colors max-md:h-touch max-md:px-4 max-md:text-sm',
                        'data-[state=on]:bg-surface data-[state=on]:font-medium data-[state=on]:text-text data-[state=on]:shadow-sm',
                        'disabled:opacity-50',
                        focusRing,
                    )}
                >
                    {option.label}
                </ToggleGroup.Item>
            ))}
        </ToggleGroup.Root>
    );
}

/** A one-of-N switch (Board / List / Forecast; 1W / 1M / 6M). Arrow keys move between items. */
export const SegmentedControl = forwardRef(SegmentedControlInner) as <V extends string>(
    props: SegmentedControlProps<V> & { ref?: React.ForwardedRef<ComponentRef<typeof ToggleGroup.Root>> },
) => React.ReactElement;
