import { cn, focusRing, toast } from '@bylinecrm/ui';
import { Copy } from 'lucide-react';

/**
 * An icon button that copies a short value (an email address) beside where it is shown. The
 * clipboard is written inside the click and the result is announced either way, never assumed.
 * A value to be pasted into another system with a visible fallback belongs in `CopyValue`.
 */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={() =>
                navigator.clipboard.writeText(value).then(
                    () => toast({ title: 'Copied', tone: 'success' }),
                    () => toast({ title: 'Could not copy — copy it by hand.', tone: 'danger' }),
                )
            }
            className={cn(
                'grid size-7 shrink-0 place-items-center rounded-sm text-text-faint hover:text-accent max-md:size-touch',
                focusRing,
                className,
            )}
        >
            <Copy aria-hidden className="size-3.5" />
        </button>
    );
}
