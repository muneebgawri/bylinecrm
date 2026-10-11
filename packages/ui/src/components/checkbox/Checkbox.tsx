import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { cn } from '../../lib/cn';
import { groupFocusRing } from '../../lib/focus';
import { phoneTouchArea } from '../../lib/touch';

export type CheckboxProps = ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>;

/**
 * A checkbox. What it shows is a 16px box; on a phone the button grows to the touch target around
 * it without taking more room (`phoneTouchArea`, FR-CRMS-UI-12). The focus ring stays on the box.
 *
 * `align-middle`: inline in a table cell or a line of text, a baseline-aligned box sits wherever its
 * content puts the baseline — apart between checked and unchecked, off-centre in the cell, and in a
 * table header 1px taller than the line. Centred on the text it sits within 1px of the cell's
 * middle in every state and density.
 */
export const Checkbox = forwardRef<ComponentRef<typeof CheckboxPrimitive.Root>, CheckboxProps>(function Checkbox(
    { className, ...props },
    ref,
) {
    return (
        <CheckboxPrimitive.Root
            ref={ref}
            className={cn(
                'peer group inline-flex shrink-0 items-center justify-center align-middle outline-none',
                'disabled:cursor-not-allowed disabled:opacity-50',
                phoneTouchArea.box,
                className,
            )}
            {...props}
        >
            <span
                aria-hidden
                className={cn(
                    'flex size-4 items-center justify-center rounded-sm border border-border-strong bg-surface-raised',
                    'group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent group-data-[state=checked]:text-accent-foreground',
                    'group-data-[state=indeterminate]:border-accent group-data-[state=indeterminate]:bg-accent group-data-[state=indeterminate]:text-accent-foreground',
                    groupFocusRing,
                )}
            >
                <CheckboxPrimitive.Indicator className="flex items-center justify-center">
                    {props.checked === 'indeterminate' ? (
                        <Minus aria-hidden className="size-3" />
                    ) : (
                        <Check aria-hidden className="size-3" />
                    )}
                </CheckboxPrimitive.Indicator>
            </span>
        </CheckboxPrimitive.Root>
    );
});
