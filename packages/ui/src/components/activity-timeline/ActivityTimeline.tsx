import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { Tone } from '../../lib/tones';
import { IconTile } from '../icon-tile/IconTile';

export interface ActivityItem {
    id: string;
    icon: ReactNode;
    tone?: Tone;
    /** "Dana Reyes" — the actor, bold. */
    actor: ReactNode;
    /** "replied to Intro v3" — what happened, muted. */
    action: ReactNode;
    /** Already formatted for the reader: "Today 09:12", "6 days ago". */
    time: string;
    /** ISO value for the `<time>` element. */
    dateTime?: string;
    /** Chips under the line: status badges, a stage change. */
    chips?: ReactNode;
}

export interface ActivityTimelineProps extends HTMLAttributes<HTMLOListElement> {
    items: readonly ActivityItem[];
}

/** The record's activity: round purple markers joined by a line, newest first. */
export const ActivityTimeline = forwardRef<HTMLOListElement, ActivityTimelineProps>(function ActivityTimeline(
    { className, items, ...props },
    ref,
) {
    return (
        <ol ref={ref} className={cn('relative m-0 list-none p-0', className)} {...props}>
            {items.map((item, i) => (
                <li key={item.id} className="relative grid grid-cols-[40px_1fr] gap-3.5 py-2">
                    {i < items.length - 1 && (
                        <span aria-hidden className="absolute top-11 -bottom-2.5 left-[19px] w-0.5 bg-border" />
                    )}
                    <IconTile tone={item.tone ?? 'accent'} size="lg" shape="round" className="relative z-[1]">
                        {item.icon}
                    </IconTile>
                    <div className="min-w-0">
                        <p className="m-0">
                            <b className="font-semibold">{item.actor}</b>{' '}
                            <span className="text-text-muted">{item.action}</span>
                        </p>
                        <time dateTime={item.dateTime} className="mt-0.5 block text-xs text-text-faint">
                            {item.time}
                        </time>
                        {item.chips && <div className="mt-2 flex flex-wrap items-center gap-2">{item.chips}</div>}
                    </div>
                </li>
            ))}
        </ol>
    );
});
