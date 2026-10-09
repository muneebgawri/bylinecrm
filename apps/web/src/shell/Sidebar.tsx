import {
    Avatar,
    Badge,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
    THEMES,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
    focusRing,
    useTheme,
    type Theme,
} from '@bylinecrm/ui';
import { Check, ChevronsUpDown, Keyboard, LogOut, Monitor, Moon, Plus, Sun } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router';
import { useLogout, useMe, useWorkspaces } from '../api/queries';
import type { WorkspaceView } from '../api/types';
import { useCan } from '../auth/capabilities';
import { paths } from '../routes/paths';
import { LogoMark } from './LogoMark';
import { NAV, type NavItem } from './nav';

export const THEME_LABELS: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' };
export const THEME_ICONS: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

export interface SidebarProps {
    workspaceId: string;
    collapsed: boolean;
    /** Closes the drawer under 900px after a navigation. */
    onNavigate?: (() => void) | undefined;
    onOpenShortcuts: () => void;
}

/**
 * The 240px sidebar: workspace switcher at the top, four nav groups, the user card at the
 * bottom. Collapsed, it shows icons with tooltips and keeps the same structure.
 */
export function Sidebar({ workspaceId, collapsed, onNavigate, onOpenShortcuts }: SidebarProps) {
    return (
        <aside
            aria-label="Sidebar"
            className="flex h-full min-w-0 flex-col gap-1.5 overflow-y-auto border-r border-border bg-surface px-3 py-3.5"
        >
            <WorkspaceSwitcher workspaceId={workspaceId} collapsed={collapsed} />
            <nav aria-label="Primary" className="flex flex-col gap-1.5">
                {NAV.map((group) => (
                    <div key={group.label} className="flex flex-col gap-0.5">
                        <div
                            className={cn(
                                'px-2.5 pt-2.5 pb-1 text-[11.5px] font-medium text-text-faint',
                                collapsed && 'sr-only',
                            )}
                        >
                            {group.label}
                        </div>
                        {group.items.map((item) => (
                            <NavEntry
                                key={item.id}
                                item={item}
                                workspaceId={workspaceId}
                                collapsed={collapsed}
                                onNavigate={onNavigate}
                            />
                        ))}
                    </div>
                ))}
            </nav>
            <UserCard collapsed={collapsed} onOpenShortcuts={onOpenShortcuts} />
        </aside>
    );
}

function NavEntry({
    item,
    workspaceId,
    collapsed,
    onNavigate,
}: {
    item: NavItem;
    workspaceId: string;
    collapsed: boolean;
    onNavigate?: (() => void) | undefined;
}) {
    const allowed = useCan(item.requires ?? 'record:read') || !item.requires;
    if (!allowed) return null;
    const Icon = item.icon;
    const link = (
        <NavLink
            to={item.to(workspaceId)}
            onClick={onNavigate}
            className={({ isActive }) =>
                cn(
                    'flex h-9 w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 text-left font-[450] text-text-muted transition-colors',
                    'hover:bg-surface-raised hover:text-text',
                    isActive && 'border-border bg-surface-raised font-medium text-text shadow-sm',
                    collapsed && 'justify-center px-0',
                    focusRing,
                )
            }
        >
            <Icon aria-hidden className="size-4.25 shrink-0" />
            {/* Collapsed, the label is still the link's name — for a screen reader and for the tooltip. */}
            <span className={cn('truncate', collapsed && 'sr-only')}>{item.label}</span>
            {!collapsed && item.badge === 'attention' && (
                <Badge
                    shape="pill"
                    status="warning"
                    className="ml-auto h-4.5 min-w-4.5 px-1.25 text-[11px] font-semibold"
                >
                    1
                </Badge>
            )}
        </NavLink>
    );
    if (!collapsed) return link;
    return (
        <Tooltip>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right">{item.label}</TooltipContent>
        </Tooltip>
    );
}

function WorkspaceSwitcher({ workspaceId, collapsed }: { workspaceId: string; collapsed: boolean }) {
    const navigate = useNavigate();
    const workspaces = useWorkspaces();
    const current: WorkspaceView | undefined = workspaces.data?.find((w) => w.id === workspaceId);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={`Workspace: ${current?.name ?? 'loading'}`}
                    className={cn(
                        'mb-2.5 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-raised',
                        collapsed && 'justify-center px-0',
                        focusRing,
                    )}
                >
                    <LogoMark />
                    {!collapsed && (
                        <>
                            <span className="min-w-0 leading-tight">
                                <b className="block truncate font-semibold">{current?.name ?? '…'}</b>
                                <span className="text-xs text-text-muted">BylineCRM</span>
                            </span>
                            <ChevronsUpDown aria-hidden className="ml-auto size-3.5 shrink-0 text-text-faint" />
                        </>
                    )}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-56">
                {(workspaces.data ?? []).map((w) => (
                    <DropdownMenuItem key={w.id} onSelect={() => navigate(paths.home(w.id))}>
                        <span className="truncate">{w.name}</span>
                        {w.id === workspaceId && <Check aria-hidden className="ml-auto" />}
                    </DropdownMenuItem>
                ))}
                <DropdownMenuItem onSelect={() => navigate(paths.workspaces)}>
                    <Plus aria-hidden /> All workspaces
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function UserCard({ collapsed, onOpenShortcuts }: { collapsed: boolean; onOpenShortcuts: () => void }) {
    const me = useMe();
    const navigate = useNavigate();
    const logout = useLogout();
    const { theme, setTheme } = useTheme();
    const email = me.data?.email ?? '';
    const name = displayName(email);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={`Account: ${email}`}
                    className={cn(
                        'mt-auto flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface p-2 text-left hover:bg-surface-raised',
                        collapsed && 'justify-center border-transparent p-1',
                        focusRing,
                    )}
                >
                    <Avatar name={name} size="sm" />
                    {!collapsed && (
                        <>
                            <span className="min-w-0 leading-tight">
                                <b className="block truncate font-medium">{name}</b>
                                <span className="block truncate text-xs text-text-muted">{email}</span>
                            </span>
                            <ChevronsUpDown aria-hidden className="ml-auto size-3.5 shrink-0 text-text-faint" />
                        </>
                    )}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="min-w-56">
                <div className="px-2 py-1.5 text-xs text-text-muted">{email}</div>
                <div className="px-2 pt-1.5 pb-1 text-[11.5px] font-medium text-text-faint">Theme</div>
                <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
                    {THEMES.map((t) => {
                        const Icon = THEME_ICONS[t];
                        return (
                            <DropdownMenuRadioItem key={t} value={t}>
                                <Icon aria-hidden />
                                {THEME_LABELS[t]}
                            </DropdownMenuRadioItem>
                        );
                    })}
                </DropdownMenuRadioGroup>
                <DropdownMenuItem onSelect={onOpenShortcuts}>
                    <Keyboard aria-hidden /> Keyboard shortcuts
                </DropdownMenuItem>
                <DropdownMenuItem
                    destructive
                    onSelect={() => logout.mutate(undefined, { onSettled: () => navigate(paths.signIn) })}
                >
                    <LogOut aria-hidden /> Sign out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** Until profiles have names (P1-1b), the part of the email before the @, title-cased. */
export function displayName(email: string): string {
    const local = email.split('@')[0] ?? '';
    return local
        .split(/[._-]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}
