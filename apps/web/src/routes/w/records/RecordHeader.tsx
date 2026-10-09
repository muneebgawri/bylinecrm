import { Avatar, Button, cn } from '@bylinecrm/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

export interface RecordHeaderProps {
    name: string;
    /** "Head of Comms · Acme Corp · dana@acme.example" */
    subtitle?: ReactNode;
    /** A status pill after the name. */
    status?: ReactNode;
    /** The right side: the primary action and its neighbours. */
    actions?: ReactNode;
    /** Prev/next within the list the page was opened from; absent when there is no list. */
    siblings?: { prev: string | null; next: string | null } | undefined;
    /** The list to go back to. */
    back?: { to: string; label: string } | undefined;
    /** `page` shows the avatar at 56px with the back link; `drawer` is tighter. */
    layout: 'page' | 'drawer';
    className?: string;
}

/** A record's identity row: avatar initials, name, the one-line summary, status, actions. */
export function RecordHeader({
    name,
    subtitle,
    status,
    actions,
    siblings,
    back,
    layout,
    className,
}: RecordHeaderProps) {
    return (
        <header className={cn('flex flex-col gap-3', className)}>
            {layout === 'page' && (back || siblings) && (
                <div className="flex items-center gap-1">
                    {back && (
                        <Button asChild variant="ghost" size="sm" shape="square" className="-ml-2 text-text-muted">
                            <Link to={back.to}>
                                <ChevronLeft aria-hidden className="size-4" />
                                {back.label}
                            </Link>
                        </Button>
                    )}
                    {siblings && (
                        <div className="ml-auto flex gap-1">
                            <Button
                                asChild={Boolean(siblings.prev)}
                                variant="secondary"
                                size="sm"
                                shape="square"
                                disabled={!siblings.prev}
                                title={siblings.prev ? 'Previous in list ([)' : 'First in the list'}
                                aria-label="Previous record"
                            >
                                {siblings.prev ? (
                                    <Link to={siblings.prev}>
                                        <ChevronLeft aria-hidden className="size-4" />
                                    </Link>
                                ) : (
                                    <ChevronLeft aria-hidden className="size-4" />
                                )}
                            </Button>
                            <Button
                                asChild={Boolean(siblings.next)}
                                variant="secondary"
                                size="sm"
                                shape="square"
                                disabled={!siblings.next}
                                title={siblings.next ? 'Next in list (])' : 'Last in the list'}
                                aria-label="Next record"
                            >
                                {siblings.next ? (
                                    <Link to={siblings.next}>
                                        <ChevronRight aria-hidden className="size-4" />
                                    </Link>
                                ) : (
                                    <ChevronRight aria-hidden className="size-4" />
                                )}
                            </Button>
                        </div>
                    )}
                </div>
            )}
            <div className="flex flex-wrap items-center gap-3.5">
                <Avatar name={name} size={layout === 'page' ? 'lg' : 'lg'} />
                <div className="min-w-0 flex-1">
                    <h1 className="m-0 flex flex-wrap items-center gap-2.5 text-xl leading-tight font-semibold tracking-tight">
                        <span className="truncate">{name}</span>
                        {status}
                    </h1>
                    {subtitle && <p className="m-0 mt-0.5 truncate text-[13px] text-text-muted">{subtitle}</p>}
                </div>
                {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            </div>
        </header>
    );
}
