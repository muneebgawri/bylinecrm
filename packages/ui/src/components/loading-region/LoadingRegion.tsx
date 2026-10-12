import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { Skeleton } from '../skeleton/Skeleton';

export interface LoadingRegionProps extends Omit<
    HTMLAttributes<HTMLDivElement>,
    'role' | 'aria-busy' | 'aria-live' | 'aria-label'
> {
    /** What is loading, as a screen reader says it: "Loading mail settings". */
    label: string;
    /** The skeleton in the shape of what is coming; a single bar when omitted. */
    children?: ReactNode;
}

/**
 * The one loading state (P1-UI-12, #95): a polite status region named for what is loading, busy
 * until the content replaces it, holding the skeleton (hidden from assistive tech) so the layout
 * does not shift. Every loading placeholder in the apps is one of these — a lint rule refuses
 * `aria-busy` written by hand.
 */
export const LoadingRegion = forwardRef<HTMLDivElement, LoadingRegionProps>(function LoadingRegion(
    { label, children, ...props },
    ref,
) {
    return (
        <div ref={ref} role="status" aria-live="polite" aria-busy="true" aria-label={label} {...props}>
            {children ?? <Skeleton className="h-10" />}
        </div>
    );
});
