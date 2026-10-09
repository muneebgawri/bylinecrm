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
import { Bell, Building2, FileText, Handshake, ListTodo, PanelLeft, Plus, Search, Users } from 'lucide-react';
import { useMatches, useNavigate } from 'react-router';
import { useCan } from '../auth/capabilities';
import { formatShortcut } from '../commands/shortcuts';
import { paths } from '../routes/paths';

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
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 font-medium text-text-muted">
                {crumbs.map((crumb, i) => (
                    <span key={`${crumb}-${i}`} className="flex items-center gap-2">
                        {i > 0 && (
                            <span aria-hidden className="text-text-faint">
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
                aria-label="Search"
                aria-keyshortcuts="Meta+K Control+K"
                className={cn(
                    'ml-auto flex h-9 items-center gap-2 rounded-md border border-border bg-surface-raised px-3 text-left text-text-faint hover:text-text-muted',
                    narrow ? 'w-9 justify-center px-0' : 'w-70',
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
            <Button variant="ghost" size="icon" shape="square" aria-label="Notifications" className="relative">
                <Bell aria-hidden />
                <span
                    aria-hidden
                    className="absolute top-1.75 right-1.75 size-1.75 rounded-full border-2 border-surface bg-danger"
                />
            </Button>
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

/** The black "+ Create" pill and its menu: person, company, deal, note, task. */
function CreateMenu({ workspaceId }: { workspaceId: string }) {
    const navigate = useNavigate();
    const canWrite = useCan('record:write');
    const canDeal = useCan('deal:edit');
    const canNote = useCan('note:write');
    const canTask = useCan('task:write');
    const entries: CreateEntry[] = [
        { id: 'person', label: 'Person', icon: Users, to: `${paths.people(workspaceId)}?create=1`, allowed: canWrite },
        {
            id: 'company',
            label: 'Company',
            icon: Building2,
            to: `${paths.companies(workspaceId)}?create=1`,
            allowed: canWrite,
        },
        { id: 'deal', label: 'Deal', icon: Handshake, to: `${paths.deals(workspaceId)}?create=1`, allowed: canDeal },
        { id: 'note', label: 'Note', icon: FileText, to: `${paths.people(workspaceId)}?create=note`, allowed: canNote },
        { id: 'task', label: 'Task', icon: ListTodo, to: `${paths.people(workspaceId)}?create=task`, allowed: canTask },
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
