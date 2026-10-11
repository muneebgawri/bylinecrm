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
import { Navigate, Outlet, useNavigate } from 'react-router';
import { useLogout, useProfile } from '../api/queries';
import { useAuthGate } from '../auth/RequireAuth';
import { WorkspaceCapabilities, useMembership } from '../auth/capabilities';
import { can } from '../auth/capabilities';
import { useRegisterCommands, type Command } from '../commands/registry';
import { useCommandShortcuts } from '../commands/shortcuts';
import { useWorkspaceId } from '../routes/params';
import { paths, withCreate } from '../routes/paths';
import { RouteSkeleton } from '../routes/states';
import { CommandPalette } from './CommandPalette';
import { OfflineBanner } from './OfflineBanner';
import { ProfileDialog } from './ProfileDialog';
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

/**
 * The workspace routes' frame, and their sign-in guard (`useAuthGate`, the rule `RequireAuth` uses).
 * The frame — sidebar, top bar — is drawn from the first frame; until the person is known to be
 * signed in, only the content area shows its loading state (P1-UI-10, FR-CRMS-UI-7). A signed-out
 * visitor is sent to sign-in. Permission-gated items wait for the membership (FR-CRMS-UI-6).
 */
export function AppShell() {
    const workspaceId = useWorkspaceId();
    const gate = useAuthGate();
    if (gate.state === 'signed-out') return <Navigate to={gate.to} replace />;
    return (
        <WorkspaceCapabilities workspaceId={workspaceId}>
            <Shell workspaceId={workspaceId} signedIn={gate.state === 'signed-in'} />
        </WorkspaceCapabilities>
    );
}

function Shell({ workspaceId, signedIn }: { workspaceId: string; signedIn: boolean }) {
    const narrow = useIsNarrow();
    const [collapsed, setCollapsed] = usePersistedState(SIDEBAR_COLLAPSED_KEY, isBoolean, false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [profileOpen, setProfileOpen] = useState(false);
    const profile = useProfile();
    // Asked once: a person who has not confirmed their name sees the prompt until they save or
    // dismiss it (either confirms it server-side), on whichever device they sign in from first.
    const needsName = profile.data?.completed === false;

    const toggleSidebar = useCallback(() => {
        if (narrow) setDrawerOpen((open) => !open);
        else setCollapsed((c) => !c);
    }, [narrow, setCollapsed]);

    useShellCommands({
        workspaceId,
        openPalette: () => setPaletteOpen(true),
        openShortcuts: () => setShortcutsOpen(true),
        openProfile: () => setProfileOpen(true),
        toggleSidebar,
    });
    useCommandShortcuts();

    const sidebar = (
        <Sidebar
            workspaceId={workspaceId}
            collapsed={!narrow && collapsed}
            onNavigate={narrow ? () => setDrawerOpen(false) : undefined}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            onOpenProfile={() => setProfileOpen(true)}
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
                <main className="min-w-0 flex-1 overflow-y-auto">{signedIn ? <Outlet /> : <RouteSkeleton />}</main>
            </div>
            <Suspense fallback={null}>
                <RecordDrawerHost />
            </Suspense>
            <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
            <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
            {profile.data && (
                <ProfileDialog
                    profile={profile.data}
                    mode={needsName ? 'prompt' : 'edit'}
                    open={profileOpen || needsName}
                    onOpenChange={setProfileOpen}
                />
            )}
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
    openProfile,
    toggleSidebar,
}: {
    workspaceId: string;
    openPalette: () => void;
    openShortcuts: () => void;
    openProfile: () => void;
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
                run: () => navigate(withCreate(paths.people(workspaceId))),
            },
            {
                id: 'create.company',
                title: 'New company',
                group: 'Create',
                shortcut: 'c c',
                when: () => can(membership, 'record:write'),
                run: () => navigate(withCreate(paths.companies(workspaceId))),
            },
            {
                id: 'create.deal',
                title: 'New deal',
                group: 'Create',
                shortcut: 'c d',
                when: () => can(membership, 'deal:edit'),
                run: () => navigate(withCreate(paths.deals(workspaceId))),
            },
            {
                id: 'create.template',
                title: 'New template',
                group: 'Create',
                when: () => can(membership, 'template:write'),
                run: () => navigate(withCreate(paths.templates(workspaceId))),
            },
            {
                id: 'nav.mailSettings',
                title: 'Mail settings',
                group: 'Go to',
                keywords: ['postal address', 'unsubscribe', 'sender'],
                when: () => can(membership, 'record:read'),
                run: () => navigate(paths.settingsMail(workspaceId)),
            },
            {
                id: 'create.mailbox',
                title: 'Connect a mailbox',
                group: 'Create',
                keywords: ['gmail', 'google', 'inbox'],
                when: () => can(membership, 'mailbox:manage'),
                run: () => navigate(withCreate(paths.mailboxes(workspaceId))),
            },
            {
                id: 'settings.google',
                title: 'Google setup',
                group: 'Go to',
                keywords: ['oauth', 'gmail', 'client id', 'redirect'],
                when: () => can(membership, 'workspace:admin'),
                run: () => navigate(paths.settingsGoogle(workspaceId)),
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
                id: 'account.profile',
                title: 'Edit profile',
                group: 'Account',
                keywords: ['name', 'display name', 'account'],
                run: openProfile,
            },
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
        [
            workspaceId,
            membership,
            theme,
            setTheme,
            navigate,
            logout,
            openPalette,
            openShortcuts,
            openProfile,
            toggleSidebar,
        ],
    );
    useRegisterCommands(commands, [commands]);
}

/** The theme the viewer actually sees: `system` resolves through the OS preference. */
export function effectiveTheme(theme: Theme): 'light' | 'dark' {
    if (theme !== 'system') return theme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
