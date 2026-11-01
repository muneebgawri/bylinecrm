import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { TONES, toneSoft, type Tone } from '../../lib/tones';

/** Up to two initials from a display name: "Dana Reyes" → "DR", "info@bigpr.com" → "I". */
export function initialsOf(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    const letters = words.length >= 2 ? [words[0], words[words.length - 1]] : [words[0] ?? '?'];
    return letters.map((w) => (w ?? '?').charAt(0).toUpperCase()).join('');
}

/** A stable tone for a name, so the same person is the same colour on every screen. */
export function toneFor(name: string): Tone {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const palette = TONES.filter((t) => t !== 'neutral' && t !== 'danger');
    return palette[hash % palette.length] ?? 'accent';
}

export const avatarVariants = cva(
    'inline-grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold select-none',
    {
        variants: {
            tone: toneSoft,
            size: {
                xs: 'size-5.5 text-[9px]',
                sm: 'size-7.5 text-[11px]',
                md: 'size-8 text-xs',
                lg: 'size-14 text-lg',
            },
        },
        defaultVariants: { size: 'md' },
    },
);

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof avatarVariants> {
    /** The person's display name; initials and the default tone come from it. */
    name: string;
    src?: string | undefined;
}

export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
    { className, name, src, tone, size, ...props },
    ref,
) {
    // A picture that will not load (removed since it was found, blocked) falls back to the initials.
    const [broken, setBroken] = useState<string | null>(null);
    const picture = src && src !== broken ? src : undefined;
    return (
        <span
            ref={ref}
            role="img"
            aria-label={name}
            className={cn(avatarVariants({ tone: tone ?? toneFor(name), size }), className)}
            {...props}
        >
            {picture ? (
                <img
                    src={picture}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="size-full object-cover"
                    onError={() => setBroken(picture)}
                />
            ) : (
                initialsOf(name)
            )}
        </span>
    );
});

export interface AvatarCellProps extends HTMLAttributes<HTMLDivElement> {
    name: string;
    /** Under the name, muted: a title, an email. */
    subline?: ReactNode;
    src?: string | undefined;
    tone?: Tone | undefined;
    size?: AvatarProps['size'];
    /** Renders the name as this element (a link) instead of plain text. */
    nameAs?: (name: string) => ReactNode;
}

/** Avatar + name + subline, as a table cell or a list row's identity. */
export const AvatarCell = forwardRef<HTMLDivElement, AvatarCellProps>(function AvatarCell(
    { className, name, subline, src, tone, size = 'md', nameAs, ...props },
    ref,
) {
    return (
        <div ref={ref} className={cn('flex min-w-0 items-center gap-2.5', className)} {...props}>
            <Avatar name={name} src={src} tone={tone} size={size} />
            <div className="min-w-0 leading-tight">
                <span className="block truncate font-medium text-text">{nameAs ? nameAs(name) : name}</span>
                {subline && <span className="block truncate text-xs text-text-muted">{subline}</span>}
            </div>
        </div>
    );
});
