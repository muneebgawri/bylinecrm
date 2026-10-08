import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

export type CheckboxProps = ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>;

export const Checkbox = forwardRef<ComponentRef<typeof CheckboxPrimitive.Root>, CheckboxProps>(function Checkbox(
    { className, ...props },
    ref,
) {
    return (
        <CheckboxPrimitive.Root
            ref={ref}
            className={cn(
                'peer size-4 shrink-0 rounded-sm border border-border-strong bg-surface-raised',
                'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground',
                'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:text-accent-foreground',
                'disabled:cursor-not-allowed disabled:opacity-50',
                focusRing,
                className,
            )}
            {...props}
        >
            <CheckboxPrimitive.Indicator className="flex items-center justify-center">
                {props.checked === 'indeterminate' ? (
                    <Minus aria-hidden className="size-3" />
                ) : (
                    <Check aria-hidden className="size-3" />
                )}
            </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
    );
});
