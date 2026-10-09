import {
    Drawer,
    DrawerContent,
    cn,
    isBoolean,
    usePersistedState,
    useTheme,
    type Theme,
    useIsNarrow,
} from '@bylinecrm/ui';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { useLogout } from '../api/queries';
import { WorkspaceCapabilities, useMembership } from '../auth/capabilities';
import { can } from '../auth/capabilities';
import { useRegisterCommands, type Command } from '../commands/registry';
import { useCommandShortcuts } from '../commands/shortcuts';
import { useWorkspaceId } from '../routes/params';
import { paths } from '../routes/paths';
import { CommandPalette } from './CommandPalette';
import { OfflineBanner } from './OfflineBanner';
import { ShortcutsSheet } from './ShortcutsSheet';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { NAV_ITEMS } from './nav';

/** The toast renderer loads after first paint; the store (`toast()`) is tiny and always there. */
const Toaster = lazy(() => import('@bylinecrm/ui/toaster').then((m) => ({ default: m.Toaster })));
import { SIDEBAR_COLLAPSED_KEY } from './storage';

/** The record drawer (`?open=<object>:<id>`) lives in the records chunk; nothing loads until it is asked for. */
const RecordDrawerHost = lazy(() =>
    import('../routes/w/records/RecordDrawerHost').then((m) => ({ default: m.RecordDrawerHost })),
);

/** The workspace routes' frame. Resolves the member's standing first, then renders the shell. */
export function AppShell() {
    const workspaceId = useWorkspaceId();
    return (
        <WorkspaceCapabilities workspaceId={workspaceId}>
            <Shell workspaceId={workspaceId} />
        </WorkspaceCapabilities>
    );
}

function Shell({ workspaceId }: { workspaceId: string }) {
    const narrow = useIsNarrow();
    const [collapsed, setCollapsed] = usePersistedState(SIDEBAR_COLLAPSED_KEY, isBoolean, false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);

    const toggleSidebar = useCallback(() => {
        if (narrow) setDrawerOpen((open) => !open);
        else setCollapsed((c) => !c);
    }, [narrow, setCollapsed]);

    useShellCommands({
        workspaceId,
        openPalette: () => setPaletteOpen(true),
        openShortcuts: () => setShortcutsOpen(true),
        toggleSidebar,
    });
    useCommandShortcuts();

    const sidebar = (
        <Sidebar
            workspaceId={workspaceId}
            collapsed={!narrow && collapsed}
            onNavigate={narrow ? () => setDrawerOpen(false) : undefined}
            onOpenShortcuts={() => setShortcutsOpen(true)}
        />
    );

    return (
        <div
            className={cn(
                'grid h-dvh min-h-160 bg-background text-text',
                narrow
                    ? 'grid-cols-1'
                    : collapsed
                      ? 'grid-cols-[var(--bc-sidebar-collapsed-width)_1fr]'
                      : 'grid-cols-[var(--bc-sidebar-width)_1fr]',
                'grid-rows-[auto_1fr]',
            )}
        >
            {!narrow && <div className="row-span-2 min-h-0">{sidebar}</div>}
            {narrow && (
                <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
                    <DrawerContent side="left" width="sm" title="Navigation" className="p-0 [&>div:first-child]:hidden">
                        {sidebar}
                    </DrawerContent>
                </Drawer>
            )}
            <TopBar
                workspaceId={workspaceId}
                onToggleSidebar={toggleSidebar}
                sidebarCollapsed={narrow ? !drawerOpen : collapsed}
                onOpenPalette={() => setPaletteOpen(true)}
            />
            {/* min-w-0: a grid item is as wide as its content by default, so a wide table pushed the page sideways. */}
            <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
                <OfflineBanner />
                <main className="min-w-0 flex-1 overflow-y-auto">
                    <Outlet />
                </main>
            </div>
            <Suspense fallback={null}>
                <RecordDrawerHost />
            </Suspense>
            <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
            <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
            <Suspense fallback={null}>
                <Toaster />
            </Suspense>
        </div>
    );
}

/** The shell's own commands: go-to for every nav item, the palette, theme, shortcuts, sign out. */
function useShellCommands({
    workspaceId,
    openPalette,
    openShortcuts,
    toggleSidebar,
}: {
    workspaceId: string;
    openPalette: () => void;
    openShortcuts: () => void;
    toggleSidebar: () => void;
}) {
    const navigate = useNavigate();
    const membership = useMembership();
    const { theme, setTheme } = useTheme();
    const logout = useLogout();

    const commands = useMemo<Command[]>(
        () => [
            ...NAV_ITEMS.map<Command>((item) => {
                const command: Command = {
                    id: `nav.${item.id}`,
                    title: item.label,
                    group: 'Go to',
                    when: () => !item.requires || can(membership, item.requires),
                    run: () => navigate(item.to(workspaceId)),
                };
                if (item.shortcut) command.shortcut = item.shortcut;
                return command;
            }),
            {
                id: 'create.person',
                title: 'New person',
                group: 'Create',
                shortcut: 'c p',
                when: () => can(membership, 'record:write'),
                run: () => navigate(`${paths.people(workspaceId)}?create=1`),
            },
            {
                id: 'create.company',
                title: 'New company',
                group: 'Create',
                shortcut: 'c c',
                when: () => can(membership, 'record:write'),
                run: () => navigate(`${paths.companies(workspaceId)}?create=1`),
            },
            {
                id: 'create.deal',
                title: 'New deal',
                group: 'Create',
                shortcut: 'c d',
                when: () => can(membership, 'deal:edit'),
                run: () => navigate(`${paths.deals(workspaceId)}?create=1`),
            },
            {
                id: 'settings.pipelines',
                title: 'Pipeline settings',
                group: 'Go to',
                keywords: ['stages', 'rules'],
                when: () => can(membership, 'pipeline:configure'),
                run: () => navigate(paths.settingsPipelines(workspaceId)),
            },
            {
                id: 'settings.customFields',
                title: 'Custom fields',
                group: 'Go to',
                keywords: ['fields', 'properties'],
                when: () => can(membership, 'workspace:admin'),
                run: () => navigate(paths.settingsCustomFields(workspaceId)),
            },
            { id: 'palette.open', title: 'Search…', group: 'Account', shortcut: 'mod+k', run: openPalette },
            { id: 'sidebar.toggle', title: 'Toggle sidebar', group: 'Account', shortcut: '[', run: toggleSidebar },
            {
                id: 'theme.toggle',
                title: `Toggle theme (now ${theme})`,
                group: 'Account',
                keywords: ['dark', 'light', 'appearance'],
                shortcut: 'mod+shift+l',
                // "Toggle" flips what is on screen: under `system` that is the OS preference, not the setting.
                run: () => setTheme(effectiveTheme(theme) === 'dark' ? 'light' : 'dark'),
            },
            { id: 'shortcuts.open', title: 'Keyboard shortcuts', group: 'Account', shortcut: '?', run: openShortcuts },
            {
                id: 'account.workspaces',
                title: 'Switch workspace',
                group: 'Account',
                run: () => navigate(paths.workspaces),
            },
            {
                id: 'account.signout',
                title: 'Sign out',
                group: 'Account',
                run: () => logout.mutate(undefined, { onSettled: () => navigate(paths.signIn) }),
            },
        ],
        [workspaceId, membership, theme, setTheme, navigate, logout, openPalette, openShortcuts, toggleSidebar],
    );
    useRegisterCommands(commands, [commands]);
}

/** The theme the viewer actually sees: `system` resolves through the OS preference. */
export function effectiveTheme(theme: Theme): 'light' | 'dark' {
    if (theme !== 'system') return theme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
