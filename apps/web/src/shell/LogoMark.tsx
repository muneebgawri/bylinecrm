import { cn } from '@bylinecrm/ui';

/**
 * The product's mark (`public/favicon.svg`, the same file as the tab's icon): in the sidebar, the workspace list
 * and the landing footer. Decorative — the name beside it, or the control's label, names it.
 */
export function LogoMark({ className, size = 'md' }: { className?: string; size?: 'md' | 'lg' }) {
    return (
        <img
            src="/favicon.svg"
            alt=""
            aria-hidden
            className={cn('shrink-0 object-contain', size === 'md' ? 'size-8' : 'size-11', className)}
        />
    );
}

/** The wordmark (`public/bylinecrm-wordmark.svg`): where the product names itself, on the landing and sign-in pages. */
export function Wordmark({ className }: { className?: string }) {
    return <img src="/bylinecrm-wordmark.svg" alt="BylineCRM" className={cn('h-7 w-auto shrink-0', className)} />;
}
