import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { toneSolid, type Tone } from '../../lib/tones';
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
            className={cn('grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-4 overflow-x-auto pb-2', className)}
            {...props}
        />
    );
}

export interface DealCardProps extends HTMLAttributes<HTMLElement> {
    /** "BC-128" */
    reference: string;
    priority?: { label: string; status?: BadgeProps['status'] };
    title: string;
    company?: string;
    /** Small chips: close date, last activity, step. */
    chips?: ReactNode;
    /** Formatted: "$12,000". */
    amount?: string;
    owner?: { name: string; tone?: Tone };
    /** "3d in stage", "Oct 2". */
    age?: string;
    highlighted?: boolean;
}

export const DealCard = forwardRef<HTMLElement, DealCardProps>(function DealCard(
    { className, reference, priority, title, company, chips, amount, owner, age, highlighted = false, ...props },
    ref,
) {
    return (
        <article
            ref={ref}
            aria-label={title}
            className={cn(
                'rounded-lg border border-border bg-surface px-4 py-3.5 shadow-sm transition-shadow hover:border-border-strong hover:shadow-md',
                highlighted && 'border-accent ring-[3px] ring-accent-soft',
                className,
            )}
            {...props}
        >
            <div className="mb-1.5 flex items-center gap-2 text-xs text-text-faint">
                {reference}
                {priority && (
                    <Badge shape="pill" status={priority.status ?? 'neutral'} className="ml-auto">
                        {priority.label}
                    </Badge>
                )}
            </div>
            <h3 className="m-0 text-sm font-semibold">{title}</h3>
            {company && <p className="m-0 mt-0.5 text-[13px] text-text-muted">{company}</p>}
            {chips && <div className="mt-2.5 flex flex-wrap items-center gap-2">{chips}</div>}
            {(amount || owner || age) && (
                <div className="mt-3 flex items-center gap-2 border-t border-border pt-2.5 text-xs text-text-muted">
                    {amount && <span className="font-semibold text-text tabular-nums">{amount}</span>}
                    {owner && <Avatar name={owner.name} tone={owner.tone} size="xs" />}
                    {age && <span className="ml-auto">{age}</span>}
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
