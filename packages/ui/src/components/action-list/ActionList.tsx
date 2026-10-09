import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { Tone } from '../../lib/tones';
import { IconTile } from '../icon-tile/IconTile';

export interface ActionListItem {
    id: string;
    /** An icon, or short text such as a weekday ("Thu"). */
    icon: ReactNode;
    tone?: Tone;
    title: ReactNode;
    subtitle?: ReactNode;
    /** Inline buttons, right-aligned. */
    actions?: ReactNode;
}

export interface ActionListProps extends HTMLAttributes<HTMLUListElement> {
    items: readonly ActionListItem[];
}

/** Rows of icon tile · title / subtitle · inline buttons: "Needs attention", "Upcoming". */
export const ActionList = forwardRef<HTMLUListElement, ActionListProps>(function ActionList(
    { className, items, ...props },
    ref,
) {
    return (
        <ul ref={ref} className={cn('m-0 list-none p-0', className)} {...props}>
            {items.map((item) => (
                <li
                    key={item.id}
                    className="grid grid-cols-[36px_1fr_auto] items-center gap-3.5 border-b border-border px-4.5 py-3 last:border-b-0"
                >
                    <IconTile tone={item.tone ?? 'accent'} className="text-xs font-semibold">
                        {item.icon}
                    </IconTile>
                    <div className="min-w-0">
                        <span className="block truncate font-medium">{item.title}</span>
                        {item.subtitle && <span className="block text-[12.5px] text-text-muted">{item.subtitle}</span>}
                    </div>
                    {item.actions && <div className="flex gap-1.5">{item.actions}</div>}
                </li>
            ))}
        </ul>
    );
});
