import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    IconTile,
    cn,
    focusRing,
    useIsNarrow,
} from '@bylinecrm/ui';
import { Building2, FileText, Handshake, ListTodo, Mail, PanelLeft, Plus, Search, Users } from 'lucide-react';
import { useMatches, useNavigate } from 'react-router';
import { useCan } from '../auth/capabilities';
import { formatShortcut } from '../commands/shortcuts';
import { NotificationsBell } from './NotificationsBell';
import { CREATE_PARAM, paths, withCreate } from '../routes/paths';

/** A route declares its breadcrumb through `handle.crumb`; the top bar reads the deepest one. */
export interface RouteHandle {
    crumb?: string;
}

export function useBreadcrumbs(): string[] {
    const matches = useMatches();
    return matches.map((m) => (m.handle as RouteHandle | undefined)?.crumb).filter((c): c is string => Boolean(c));
}

export interface TopBarProps {
    workspaceId: string;
    onToggleSidebar: () => void;
    sidebarCollapsed: boolean;
    onOpenPalette: () => void;
}

/** 56px: collapse toggle, breadcrumb, the 280px search field with its ⌘K key cap, bell, + Create. */
export function TopBar({ workspaceId, onToggleSidebar, sidebarCollapsed, onOpenPalette }: TopBarProps) {
    const crumbs = useBreadcrumbs();
    const narrow = useIsNarrow();
    return (
        <header className="flex h-topbar items-center gap-2.5 border-b border-border bg-surface px-5">
            <Button
                variant="ghost"
                size="icon"
                shape="square"
                onClick={onToggleSidebar}
                aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-expanded={!sidebarCollapsed}
            >
                <PanelLeft aria-hidden />
            </Button>
            {/*
             * The breadcrumb shrinks before the buttons beside it and truncates instead of running under
             * them. On a phone only the current page is named — "Settings / Custom fields" does not fit
             * next to search, notifications and Create at 375px (FR-CRMS-UI-12).
             */}
            <nav
                aria-label="Breadcrumb"
                className="flex min-w-0 items-center gap-2 overflow-hidden font-medium text-text-muted"
            >
                {crumbs.map((crumb, i) => (
                    <span
                        key={`${crumb}-${i}`}
                        className={cn('flex min-w-0 items-center gap-2', i < crumbs.length - 1 && 'max-md:hidden')}
                    >
                        {i > 0 && (
                            <span aria-hidden className="text-text-faint max-md:hidden">
                                /
                            </span>
                        )}
                        <span
                            className={cn('truncate', i === crumbs.length - 1 && 'text-text')}
                            aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                        >
                            {crumb}
                        </span>
                    </span>
                ))}
            </nav>
            <button
                type="button"
                onClick={onOpenPalette}
                // Icon-only when narrow, so it needs a name; wide, its visible "Search…" is the name
                // (an aria-label there would hide the visible text from it — WCAG 2.5.3).
                aria-label={narrow ? 'Search' : undefined}
                aria-keyshortcuts="Meta+K Control+K"
                className={cn(
                    'ml-auto flex h-9 shrink-0 items-center gap-2 rounded-md border border-border bg-surface-raised px-3 text-left text-text-faint hover:text-text-muted',
                    narrow ? 'w-9 justify-center px-0 max-md:size-touch' : 'w-70',
                    focusRing,
                )}
            >
                <Search aria-hidden className="size-4 shrink-0" />
                {!narrow && (
                    <>
                        <span className="text-sm">Search…</span>
                        <kbd className="ml-auto rounded-[5px] border border-border bg-surface px-1.5 text-[11px] font-sans text-text-faint">
                            {formatShortcut('mod+k')}
                        </kbd>
                    </>
                )}
            </button>
            <NotificationsBell workspaceId={workspaceId} />
            <CreateMenu workspaceId={workspaceId} />
        </header>
    );
}

interface CreateEntry {
    id: string;
    label: string;
    icon: typeof Users;
    to: string;
    allowed: boolean;
}

/** The black "+ Create" pill and its menu: person, company, deal, note, task, template. */
function CreateMenu({ workspaceId }: { workspaceId: string }) {
    const navigate = useNavigate();
    const canWrite = useCan('record:write');
    const canDeal = useCan('deal:edit');
    const canNote = useCan('note:write');
    const canTask = useCan('task:write');
    const canTemplate = useCan('template:write');
    const entries: CreateEntry[] = [
        { id: 'person', label: 'Person', icon: Users, to: withCreate(paths.people(workspaceId)), allowed: canWrite },
        {
            id: 'company',
            label: 'Company',
            icon: Building2,
            to: withCreate(paths.companies(workspaceId)),
            allowed: canWrite,
        },
        { id: 'deal', label: 'Deal', icon: Handshake, to: withCreate(paths.deals(workspaceId)), allowed: canDeal },
        {
            id: 'note',
            label: 'Note',
            icon: FileText,
            to: `${paths.people(workspaceId)}?${CREATE_PARAM}=note`,
            allowed: canNote,
        },
        {
            id: 'task',
            label: 'Task',
            icon: ListTodo,
            to: `${paths.people(workspaceId)}?${CREATE_PARAM}=task`,
            allowed: canTask,
        },
        {
            id: 'template',
            label: 'Template',
            icon: Mail,
            to: withCreate(paths.templates(workspaceId)),
            allowed: canTemplate,
        },
    ].filter((e) => e.allowed);
    if (entries.length === 0) return null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="primary">
                    <Plus aria-hidden /> Create
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
                {entries.map((entry) => (
                    <DropdownMenuItem key={entry.id} onSelect={() => navigate(entry.to)}>
                        <IconTile size="sm" tone="neutral">
                            <entry.icon />
                        </IconTile>
                        {entry.label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
