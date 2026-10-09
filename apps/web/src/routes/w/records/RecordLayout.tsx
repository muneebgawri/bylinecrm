import { cn } from '@bylinecrm/ui';
import type { ReactNode } from 'react';

/**
 * The record page's frame (doc 50 §A, mockup v3): header, then a fact row, then three columns —
 * properties on the left, the compose area and the activity in the centre, the rail of related
 * things on the right. In the drawer the same parts stack in one column.
 */
export function RecordLayout({
    layout,
    header,
    facts,
    properties,
    children,
    rail,
}: {
    layout: 'page' | 'drawer';
    header: ReactNode;
    facts?: ReactNode;
    properties: ReactNode;
    children: ReactNode;
    rail: ReactNode;
}) {
    if (layout === 'drawer') {
        return (
            <div className="flex flex-col gap-4 px-5.5 py-5">
                {header}
                {facts}
                {children}
                <div className="flex flex-col gap-3.5">{rail}</div>
                {properties}
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-5 p-7">
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
    );
}
