import { cn } from '@bylinecrm/ui';

/** The black square with the letter: the product's mark, in the sidebar and on the auth card. */
export function LogoMark({ className, size = 'md' }: { className?: string; size?: 'md' | 'lg' }) {
    return (
        <span
            aria-hidden
            className={cn(
                'grid shrink-0 place-items-center rounded-[9px] bg-primary font-bold text-primary-foreground',
                size === 'md' ? 'size-8 text-[13px]' : 'size-11 rounded-xl text-lg',
                className,
            )}
        >
            B
        </span>
    );
}
