import * as SwitchPrimitive from '@radix-ui/react-switch';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { cn } from '../../lib/cn';
import { groupFocusRing } from '../../lib/focus';
import { phoneTouchArea } from '../../lib/touch';

export type SwitchProps = ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>;

/**
 * An on/off control. What it shows is a 36×20 track; on a phone the button grows to the touch
 * target around it without taking more room (`phoneTouchArea`, FR-CRMS-UI-12), so a finger anywhere
 * in the 44×44 square toggles it. The focus ring stays on the track.
 */
export const Switch = forwardRef<ComponentRef<typeof SwitchPrimitive.Root>, SwitchProps>(function Switch(
    { className, ...props },
    ref,
) {
    return (
        <SwitchPrimitive.Root
            ref={ref}
            className={cn(
                'group inline-flex shrink-0 cursor-pointer items-center justify-center outline-none',
                'disabled:cursor-not-allowed disabled:opacity-50',
                phoneTouchArea.track,
                className,
            )}
            {...props}
        >
            <span
                aria-hidden
                className={cn(
                    'inline-flex h-5 w-9 items-center rounded-full border-2 border-transparent transition-colors',
                    'group-data-[state=checked]:bg-accent group-data-[state=unchecked]:bg-border-strong',
                    groupFocusRing,
                )}
            >
                <SwitchPrimitive.Thumb
                    className={cn(
                        'pointer-events-none block size-4 rounded-full bg-surface-raised shadow-sm transition-transform',
                        'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
                    )}
                />
            </span>
        </SwitchPrimitive.Root>
    );
});
