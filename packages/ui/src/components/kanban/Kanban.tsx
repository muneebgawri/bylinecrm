import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { toneSoft, toneSolid, type Tone } from '../../lib/tones';
import { Building2, CalendarDays, User } from 'lucide-react';
import { Avatar } from '../avatar/Avatar';
import { Badge, type BadgeProps } from '../badge/Badge';

export interface KanbanLaneProps extends HTMLAttributes<HTMLElement> {
    name: string;
    tone?: Tone;
    count: number;
    /** The lane's total, formatted: "$48,000". */
    sum?: string;
    /** The lane's menu button or other header control. */
    menu?: ReactNode;
    /** "10 more" — a ghost card at the end. */
    more?: string;
    children?: ReactNode;
}

/** One pipeline column: a stage chip with its dot and count, the sum, the cards. */
export const KanbanLane = forwardRef<HTMLElement, KanbanLaneProps>(function KanbanLane(
    { className, name, tone = 'accent', count, sum, menu, more, children, ...props },
    ref,
) {
    return (
        <section ref={ref} aria-label={`${name}, ${count}`} className={cn('min-w-0', className)} {...props}>
            <div className="flex items-center gap-2 px-1 pt-1.5 pb-3">
                <span className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1 font-medium">
                    <span aria-hidden className={cn('size-2 rounded-full', toneSolid[tone])} />
                    {name}
                    <span className="text-xs text-text-faint tabular-nums">{count}</span>
                </span>
                {sum && <span className="ml-auto text-xs text-text-muted tabular-nums">{sum}</span>}
                {menu}
            </div>
            <div className="flex flex-col gap-3">
                {children}
                {more && (
                    <div className="rounded-lg border-[1.5px] border-dashed border-border-strong px-4 py-3.5 text-center text-text-faint">
                        {more}
                    </div>
                )}
            </div>
        </section>
    );
});

/** The scrolling row of lanes. */
export function KanbanBoard({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        // A scrolling region is reachable from the keyboard (tabIndex) and named, so it can be scrolled without a pointer.
        <div
            role="region"
            aria-label="Pipeline board"
            tabIndex={0}
            // `relative` so absolutely positioned descendants (sr-only text) are clipped by this scroller
            // instead of widening the page.
            className={cn(
                'relative grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-4 overflow-x-auto pb-2',
                className,
            )}
            {...props}
        />
    );
}

export interface DealCardProps extends HTMLAttributes<HTMLElement> {
    /** "BC-128" — read out and shown on hover, not drawn. */
    reference: string;
    priority?: { label: string; status?: BadgeProps['status'] };
    title: string;
    company?: string;
    /** Small chips under the value: a warning, a step. */
    chips?: ReactNode;
    /** Formatted: "$12,000". */
    amount?: string;
    /** 0–100: the bar under the value and the chip beside it. */
    probability?: number;
    /** The person on the other side, named in the footer. */
    contact?: string;
    /** The expected close, in the footer: the day shown, the label read out and on hover. */
    date?: { label: string; value: string };
    owner?: { name: string; tone?: Tone };
    /** "3d in stage", "Oct 2" — in the footer when there is no contact. */
    age?: string;
    highlighted?: boolean;
}

/** The bar and chip colour by how likely the deal is: green from 70, amber from 40, red below. */
function probabilityTone(probability: number): Tone {
    return probability >= 70 ? 'success' : probability >= 40 ? 'warning' : 'danger';
}

/**
 * A pipeline card: a building tile, the deal's name and company, the value with its probability
 * chip and bar, then a muted footer naming the contact, the close date and the owner's avatar.
 */
export const DealCard = forwardRef<HTMLElement, DealCardProps>(function DealCard(
    {
        className,
        reference,
        priority,
        title,
        company,
        chips,
        amount,
        probability,
        contact,
        date,
        owner,
        age,
        highlighted = false,
        ...props
    },
    ref,
) {
    const tone = probability === undefined ? undefined : probabilityTone(probability);
    return (
        <article
            ref={ref}
            aria-label={title}
            title={reference}
            className={cn(
                'group relative overflow-hidden rounded-xl border border-border bg-surface shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md',
                highlighted && 'border-accent ring-[3px] ring-accent-soft',
                className,
            )}
            {...props}
        >
            <div className="space-y-3 p-3.5">
                <div className="flex items-start gap-3">
                    <span
                        aria-hidden
                        className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-raised text-text-muted [&_svg]:size-4"
                    >
                        <Building2 />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h3 className="m-0 truncate text-sm leading-tight font-semibold">{title}</h3>
                        {company && <p className="m-0 mt-0.5 truncate text-xs text-text-muted">{company}</p>}
                        <span className="sr-only">{reference}</span>
                    </div>
                    {priority && (
                        <Badge shape="pill" status={priority.status ?? 'neutral'} className="-mt-0.5 shrink-0">
                            {priority.label}
                        </Badge>
                    )}
                </div>
                {(amount || tone) && (
                    <div className="space-y-2">
                        <div className="flex items-end justify-between gap-2">
                            {amount && (
                                <span className="text-xl leading-none font-bold tracking-tight tabular-nums">
                                    {amount}
                                </span>
                            )}
                            {tone && (
                                <span
                                    className={cn(
                                        'ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold',
                                        toneSoft[tone],
                                    )}
                                >
                                    {probability}%
                                </span>
                            )}
                        </div>
                        {tone && (
                            <span className="block h-1 w-full overflow-hidden rounded-full bg-surface-raised">
                                <span
                                    className={cn('block h-full rounded-full', toneSolid[tone])}
                                    style={{ width: `${probability}%` }}
                                />
                            </span>
                        )}
                    </div>
                )}
                {chips && <div className="flex flex-wrap items-center gap-2">{chips}</div>}
            </div>
            {(contact || date || owner || age) && (
                <div className="flex items-center justify-between gap-2 border-t border-border bg-surface-raised/40 px-3.5 py-2.5 text-xs text-text-muted">
                    <span className="flex min-w-0 items-center gap-1.5">
                        {contact ? (
                            <>
                                <User aria-hidden className="size-3.5 shrink-0" />
                                <span className="truncate">{contact}</span>
                            </>
                        ) : (
                            age && <span className="truncate">{age}</span>
                        )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                        {date && (
                            <span className="flex items-center gap-1 text-[11px]" title={`${date.label} ${date.value}`}>
                                <CalendarDays aria-hidden className="size-3.5" />
                                <span className="sr-only">{date.label} </span>
                                {date.value}
                            </span>
                        )}
                        {owner && (
                            <Avatar name={owner.name} tone={owner.tone} size="xs" className="border border-border" />
                        )}
                    </span>
                </div>
            )}
        </article>
    );
});

/** A small bordered chip on a card: "◷ Close Oct 31", "Step 2 of 3". */
export function CardChip({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
    return (
        <span
            className={cn(
                'inline-flex h-6 items-center gap-1.25 rounded-sm border border-border bg-surface-raised px-2 text-xs text-text-muted [&_svg]:size-3',
                className,
            )}
            {...props}
        />
    );
}
