import {
    Avatar,
    Badge,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
    Skeleton,
    THEMES,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
    focusRing,
    useTheme,
    type Theme,
} from '@bylinecrm/ui';
import {
    ArrowLeft,
    Check,
    ChevronRight,
    ChevronsUpDown,
    Keyboard,
    LogOut,
    Monitor,
    Moon,
    Plus,
    Sun,
    UserRound,
} from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { useLogout, useProfile, useWorkspaces } from '../api/queries';
import type { MembershipSummary, WorkspaceView } from '../api/types';
import { can, useMembership } from '../auth/capabilities';
import { paths } from '../routes/paths';
import { LogoMark } from './LogoMark';
import { NAV, type NavGroup, type NavItem } from './nav';
import { SETTINGS_NAV } from './settingsNav';

export const THEME_LABELS: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' };
export const THEME_ICONS: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

export interface SidebarProps {
    workspaceId: string;
    collapsed: boolean;
    /** Closes the drawer under 900px after a navigation. */
    onNavigate?: (() => void) | undefined;
    onOpenShortcuts: () => void;
    onOpenProfile: () => void;
}

/** The items of a group the member may use; every item while the membership is still unknown. */
function visibleItems(group: NavGroup, membership: MembershipSummary | null): readonly NavItem[] {
    return group.items.filter((item) => !item.requires || can(membership, item.requires));
}

/**
 * The 256px sidebar: workspace switcher at the top, four nav groups, the user card at the
 * bottom. Collapsed, it shows icons with tooltips and keeps the same structure. Under `/settings`
 * the groups are settings' sections behind a way back to the app, so there is only ever one sidebar.
 *
 * A group is never a heading with nothing under it (P1-UI-10): until the membership is known, each
 * gated item is a loading row in its place (so nothing shifts when it resolves); once known, a
 * group the member can use nothing in is not drawn at all.
 */
export function Sidebar({ workspaceId, collapsed, onNavigate, onOpenShortcuts, onOpenProfile }: SidebarProps) {
    const membership = useMembership();
    const known = membership !== null;
    const { pathname } = useLocation();
    const settingsRoot = paths.settings(workspaceId);
    const inSettings = pathname === settingsRoot || pathname.startsWith(`${settingsRoot}/`);
    const groups: readonly NavGroup[] = inSettings ? SETTINGS_NAV : NAV;
    return (
        <aside
            aria-label="Sidebar"
            className="flex h-full min-w-0 flex-col gap-1.5 overflow-y-auto bg-background px-3 py-3.5"
        >
            <WorkspaceSwitcher workspaceId={workspaceId} collapsed={collapsed} />
            {inSettings && <BackToApp workspaceId={workspaceId} collapsed={collapsed} onNavigate={onNavigate} />}
            <nav aria-label={inSettings ? 'Settings' : 'Primary'} className="flex flex-col gap-1.5">
                {groups.map((group) => {
                    const items = known ? visibleItems(group, membership) : group.items;
                    if (items.length === 0) return null;
                    return (
                        <div key={group.label} className="flex flex-col gap-0.5">
                            <div
                                className={cn(
                                    'px-2.5 pt-3 pb-1.5 text-xs font-medium text-text-faint',
                                    collapsed && 'sr-only',
                                )}
                            >
                                {group.label}
                            </div>
                            {items.map((item) =>
                                known || !item.requires ? (
                                    item.children && !inSettings ? (
                                        <NavSection
                                            key={item.id}
                                            item={item}
                                            workspaceId={workspaceId}
                                            collapsed={collapsed}
                                            onNavigate={onNavigate}
                                        />
                                    ) : (
                                        <NavEntry
                                            key={item.id}
                                            item={item}
                                            workspaceId={workspaceId}
                                            collapsed={collapsed}
                                            onNavigate={onNavigate}
                                        />
                                    )
                                ) : (
                                    <NavSkeleton key={item.id} collapsed={collapsed} />
                                ),
                            )}
                        </div>
                    );
                })}
            </nav>
            <UserCard collapsed={collapsed} onOpenShortcuts={onOpenShortcuts} onOpenProfile={onOpenProfile} />
        </aside>
    );
}

/** Settings' way out: back to the workspace's home, where the app's own groups are. */
function BackToApp({
    workspaceId,
    collapsed,
    onNavigate,
}: {
    workspaceId: string;
    collapsed: boolean;
    onNavigate?: (() => void) | undefined;
}) {
    const link = (
        <Link
            to={paths.home(workspaceId)}
            onClick={onNavigate}
            className={cn(
                'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 font-[450] text-text-muted transition-colors hover:bg-surface-raised hover:text-text',
                collapsed && 'justify-center px-0',
                focusRing,
            )}
        >
            <ArrowLeft aria-hidden className="size-4.25 shrink-0" />
            <span className={cn('truncate', collapsed && 'sr-only')}>Back to app</span>
        </Link>
    );
    if (!collapsed) return link;
    return (
        <Tooltip>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side="right">Back to app</TooltipContent>
        </Tooltip>
    );
}

const ROW =
    'flex h-9 w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 text-left font-[450] text-text-muted transition-colors hover:border-border hover:bg-surface hover:text-text hover:shadow-sm';
const ACTIVE = 'border-border bg-surface font-medium text-text shadow-sm';

/**
 * An item with sub-pages: the row opens and closes the list beneath it, and is itself active while
 * any of its pages is open. Collapsed, only the icon shows and it goes straight to the first page.
 */
function NavSection({
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
    const Icon = item.icon;
    const membership = useMembership();
    const location = useLocation();
    const href = item.to(workspaceId);
    const inSection = location.pathname === href || location.pathname.startsWith(`${href}/`);
    const [open, setOpen] = useState(inSection);
    const children = (item.children ?? []).filter((c) => !c.requires || can(membership, c.requires));
    if (collapsed) return <NavEntry item={item} workspaceId={workspaceId} collapsed onNavigate={onNavigate} />;
    const here = location.pathname + location.search;
    const expanded = open || inSection;
    return (
        <div className="flex flex-col gap-0.5">
            <div className={cn(ROW, 'gap-0 px-0', inSection && ACTIVE)}>
                <Link
                    to={href}
                    onClick={onNavigate}
                    aria-current={inSection ? 'page' : undefined}
                    className={cn('flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md pl-2.5', focusRing)}
                >
                    <Icon aria-hidden className="size-4.25 shrink-0" />
                    <span className="truncate">{item.label}</span>
                </Link>
                <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? 'Hide' : 'Show'} ${item.label} pages`}
                    onClick={() => setOpen((o) => !o)}
                    className={cn('grid h-full w-8 shrink-0 place-items-center rounded-md', focusRing)}
                >
                    <ChevronRight aria-hidden className={cn('size-4 transition-transform', expanded && 'rotate-90')} />
                </button>
            </div>
            {expanded && (
                <ul className="m-0 mb-1 ml-5 flex list-none flex-col gap-0.5 border-l border-border py-0.5 pl-2.5">
                    {children.map((child) => {
                        const to = child.to(workspaceId);
                        const active = here === to || (child === children[0] && here === href);
                        return (
                            <li key={child.id}>
                                <Link
                                    to={to}
                                    onClick={onNavigate}
                                    aria-current={active ? 'page' : undefined}
                                    className={cn(
                                        'flex h-8 items-center rounded-md border border-transparent px-2.5 text-[13px] text-text-muted transition-colors hover:border-border hover:bg-surface hover:text-text hover:shadow-sm',
                                        active && ACTIVE,
                                        focusRing,
                                    )}
                                >
                                    {child.label}
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
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
    const Icon = item.icon;
    const link = (
        <NavLink
            to={item.to(workspaceId)}
            onClick={onNavigate}
            className={({ isActive }) =>
                cn(
                    'flex h-9 w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 text-left font-[450] text-text-muted transition-colors',
                    'hover:border-border hover:bg-surface hover:text-text hover:shadow-sm',
                    isActive && 'border-border bg-surface font-medium text-text shadow-sm',
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

/** A nav row's place while the membership loads: same height, no label to read out. */
function NavSkeleton({ collapsed }: { collapsed: boolean }) {
    return (
        <div
            data-nav-skeleton
            aria-hidden
            className={cn('flex h-9 items-center gap-2.5 px-2.5', collapsed && 'justify-center px-0')}
        >
            <Skeleton className="size-4.25 shrink-0 rounded-sm" />
            {!collapsed && <Skeleton className="h-3 w-24" />}
        </div>
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
                    // Collapsed it shows only the logo, so it needs a name; expanded, the visible
                    // workspace name is the name, with a hidden prefix (WCAG 2.5.3, label in name).
                    aria-label={collapsed ? `Workspace: ${current?.name ?? 'loading'}` : undefined}
                    className={cn(
                        'mb-2.5 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-raised',
                        collapsed && 'justify-center px-0',
                        focusRing,
                    )}
                >
                    <LogoMark />
                    {!collapsed && (
                        <>
                            <span className="sr-only">Workspace: </span>
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

function UserCard({
    collapsed,
    onOpenShortcuts,
    onOpenProfile,
}: {
    collapsed: boolean;
    onOpenShortcuts: () => void;
    onOpenProfile: () => void;
}) {
    const profile = useProfile();
    const navigate = useNavigate();
    const logout = useLogout();
    const { theme, setTheme } = useTheme();
    const email = profile.data?.email ?? '';
    // The person's own name (P1-UI-10); the address only while the profile loads or has none.
    const name = profile.data?.displayName ?? email;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={collapsed ? `Account: ${email}` : undefined}
                    className={cn(
                        'mt-auto flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface p-2 text-left shadow-sm hover:bg-surface-raised',
                        collapsed && 'justify-center border-transparent p-1',
                        focusRing,
                    )}
                >
                    <Avatar name={name} size="sm" />
                    {!collapsed && (
                        <>
                            <span className="sr-only">Account: </span>
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
                <DropdownMenuItem onSelect={onOpenProfile}>
                    <UserRound aria-hidden /> Profile
                </DropdownMenuItem>
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
