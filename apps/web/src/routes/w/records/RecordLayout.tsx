import { cn } from '@bylinecrm/ui';
import type { ReactNode } from 'react';

/**
 * The record page's frame (doc 50 §A, mockup v3): header, then a fact row, then three columns —
 * properties on the left, the compose area and the activity in the centre, the rail of related
 * things on the right. In the drawer the same parts stack in one column.
 *
 * `bar` is the phone's bottom action bar (`RecordActionBar`). It is the last child of a wrapper
 * that spans the whole record, so its `sticky bottom-0` keeps it on screen through the scroll and
 * it takes its own space at the end — nothing is hidden behind it (FR-CRMS-UI-12).
 */
export function RecordLayout({
    layout,
    header,
    facts,
    properties,
    children,
    rail,
    bar,
}: {
    layout: 'page' | 'drawer';
    bar?: ReactNode;
    header: ReactNode;
    facts?: ReactNode;
    properties: ReactNode;
    children: ReactNode;
    rail: ReactNode;
}) {
    if (layout === 'drawer') {
        return (
            <div className="flex flex-1 flex-col">
                <div className="flex flex-col gap-4 px-5.5 py-5">
                    {header}
                    {facts}
                    {children}
                    <div className="flex flex-col gap-3.5">{rail}</div>
                    {properties}
                </div>
                {bar}
            </div>
        );
    }
    return (
        <div className="flex flex-col">
            <div className="flex flex-col gap-5 p-7 max-md:p-4">
                {header}
                {facts}
                <div
                    className={cn(
                        'grid gap-4',
                        'grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)_280px] lg:grid-cols-[minmax(0,1fr)_280px]',
                    )}
                >
                    <div className="order-2 min-w-0 lg:order-1 lg:col-span-2 xl:col-span-1">{properties}</div>
                    <div className="order-1 flex min-w-0 flex-col gap-4 lg:order-2 lg:col-span-2 xl:col-span-1">
                        {children}
                    </div>
                    <div className="order-3 flex min-w-0 flex-col gap-3.5 lg:col-span-2 xl:col-span-1">{rail}</div>
                </div>
            </div>
            {bar}
        </div>
    );
}
