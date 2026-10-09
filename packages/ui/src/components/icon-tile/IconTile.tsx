import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { toneSoft } from '../../lib/tones';

/**
 * The tinted square an icon sits in — KPI cards, action lists, timeline items and the create
 * menu all use this one shape. Decorative: the text beside it carries the meaning.
 */
export const iconTileVariants = cva('grid shrink-0 place-items-center [&_svg]:shrink-0 [&_svg]:stroke-[1.8]', {
    variants: {
        tone: toneSoft,
        size: {
            sm: 'size-8 rounded-md [&_svg]:size-4',
            md: 'size-9 rounded-[10px] [&_svg]:size-4.25',
            lg: 'size-10 rounded-[10px] [&_svg]:size-4.75',
        },
        shape: { square: '', round: 'rounded-full' },
    },
    defaultVariants: { tone: 'accent', size: 'md', shape: 'square' },
});

export interface IconTileProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof iconTileVariants> {}

export const IconTile = forwardRef<HTMLDivElement, IconTileProps>(function IconTile(
    { className, tone, size, shape, ...props },
    ref,
) {
    return <div ref={ref} aria-hidden className={cn(iconTileVariants({ tone, size, shape }), className)} {...props} />;
});
