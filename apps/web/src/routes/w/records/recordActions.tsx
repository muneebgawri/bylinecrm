import {
    BottomActionBar,
    BottomActionBarItem,
    Button,
    Dialog,
    DialogContent,
    DialogTitle,
    toast,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@bylinecrm/ui';
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * One action on a record. A record page declares its actions ONCE, as a list of these; the header
 * renders them as buttons on a tablet or desktop, the bottom bar renders the same list on a phone
 * (FR-CRMS-UI-12). Two renderings of one list, so they cannot drift apart.
 */
export interface RecordAction {
    id: string;
    /** The header's label ("Add note"). */
    label: string;
    /** The bottom bar's shorter label ("Note"). */
    short: string;
    icon: ReactNode;
    onSelect?: () => void;
    /** The record's one emphasised action; it carries `data-primary-action` (the route gate's check). */
    primary?: boolean;
    /** Why the action is unavailable; set together with `disabled`. */
    reason?: string | undefined;
    disabled?: boolean;
    /** The enabled action's hint, e.g. its keyboard shortcut. */
    hint?: string;
}

/** The record's actions as header buttons (tablet and desktop). An unavailable one says why on hover and focus. */
export function RecordHeaderActions({ actions }: { actions: readonly RecordAction[] }) {
    return (
        <>
            {actions.map((action) => {
                const button = (
                    <Button
                        {...(action.primary ? { 'data-primary-action': '' } : {})}
                        variant={action.primary ? 'primary' : 'secondary'}
                        shape="square"
                        size="sm"
                        onClick={action.onSelect}
                        disabled={action.disabled}
                        title={action.disabled ? undefined : action.hint}
                    >
                        {action.label}
                    </Button>
                );
                if (!action.disabled || !action.reason) return <Fragment key={action.id}>{button}</Fragment>;
                return (
                    <Tooltip key={action.id}>
                        <TooltipTrigger asChild>
                            {/* A disabled button takes no focus; the wrapper does, so the reason is reachable. */}
                            <span tabIndex={0}>{button}</span>
                        </TooltipTrigger>
                        <TooltipContent>{action.reason}</TooltipContent>
                    </Tooltip>
                );
            })}
        </>
    );
}

export interface RecordActionBarProps {
    /** The record's name, for the bar's accessible name ("Dana Reyes actions"). */
    name: string;
    actions: readonly RecordAction[];
    /** Prev/next within the list the page came from: on a phone they live in the "More" sheet. */
    siblings?: { prev: string | null; next: string | null } | undefined;
}

/**
 * The record's actions on a phone, in a bar at the bottom of the screen. A tap on an unavailable
 * action says why in a toast — a phone has no hover, so a tooltip would never be seen. "More"
 * opens a sheet with what does not fit; it is left out when there is nothing to put in it.
 */
export function RecordActionBar({ name, actions, siblings }: RecordActionBarProps) {
    const [moreOpen, setMoreOpen] = useState(false);
    const more = [
        siblings?.prev
            ? { id: 'prev', label: 'Previous record', to: siblings.prev, icon: <ChevronLeft aria-hidden /> }
            : null,
        siblings?.next
            ? { id: 'next', label: 'Next record', to: siblings.next, icon: <ChevronRight aria-hidden /> }
            : null,
    ].filter((item) => item !== null);

    return (
        <>
            <BottomActionBar label={`${name} actions`}>
                {actions.map((action) => (
                    <BottomActionBarItem
                        key={action.id}
                        icon={action.icon}
                        primary={action.primary ?? false}
                        {...(action.primary ? { 'data-primary-action': '' } : {})}
                        aria-label={action.label}
                        {...(action.disabled ? { 'aria-disabled': true } : {})}
                        onClick={() => {
                            if (action.disabled) {
                                if (action.reason) toast({ title: action.reason });
                                return;
                            }
                            action.onSelect?.();
                        }}
                    >
                        {action.short}
                    </BottomActionBarItem>
                ))}
                {more.length > 0 && (
                    <BottomActionBarItem
                        icon={<MoreHorizontal aria-hidden />}
                        aria-haspopup="dialog"
                        onClick={() => setMoreOpen(true)}
                    >
                        More
                    </BottomActionBarItem>
                )}
            </BottomActionBar>
            {more.length > 0 && (
                <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
                    <DialogContent aria-describedby={undefined}>
                        <DialogTitle>More</DialogTitle>
                        <nav aria-label="More actions" className="flex flex-col gap-1">
                            {more.map((item) => (
                                <Button
                                    key={item.id}
                                    asChild
                                    variant="ghost"
                                    shape="square"
                                    className="min-h-touch justify-start"
                                >
                                    <Link to={item.to} onClick={() => setMoreOpen(false)}>
                                        {item.icon}
                                        {item.label}
                                    </Link>
                                </Button>
                            ))}
                        </nav>
                    </DialogContent>
                </Dialog>
            )}
        </>
    );
}
