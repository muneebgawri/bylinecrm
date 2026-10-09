import type { Capability } from '@bylinecrm/shared';
import { PageHeader, cn, focusRing } from '@bylinecrm/ui';
import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useMembership, can } from '../../../auth/capabilities';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';

/**
 * The settings sections, each with the capability that shows it (FR-CRMS-UI-6). Most are an
 * admin's; mail settings are readable by every member who reads records — the postal address and
 * unsubscribe wording every outreach email carries — and editable by an admin on the page itself.
 */
const SECTIONS: readonly { id: string; label: string; to: (workspaceId: string) => string; requires: Capability }[] = [
    { id: 'members', label: 'Members', to: paths.settingsMembers, requires: 'workspace:admin' },
    { id: 'roles', label: 'Roles', to: paths.settingsRoles, requires: 'workspace:admin' },
    { id: 'api-keys', label: 'API keys', to: paths.settingsApiKeys, requires: 'workspace:admin' },
    { id: 'invites', label: 'Invites', to: paths.settingsInvites, requires: 'workspace:admin' },
    { id: 'pipelines', label: 'Pipelines', to: paths.settingsPipelines, requires: 'workspace:admin' },
    { id: 'mail', label: 'Mail', to: paths.settingsMail, requires: 'record:read' },
];

/** Workspace settings: a section row, then the section. The server is the gate for each section's data. */
export function SettingsLayout() {
    const workspaceId = useWorkspaceId();
    const membership = useMembership();
    const sections = SECTIONS.filter((section) => can(membership, section.requires));
    // On a phone the section row scrolls inside itself; the open section is kept in view.
    const nav = useRef<HTMLElement>(null);
    const { pathname } = useLocation();
    useEffect(() => {
        nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [pathname, sections.length]);
    return (
        <div className="p-7">
            <PageHeader
                title="Settings"
                subtitle="Who is in the workspace, what they may do, the machines that may call it, and how its mail is signed."
            />
            <nav ref={nav} aria-label="Settings sections" className="mb-4 flex gap-1 overflow-x-auto">
                {sections.map((section) => (
                    <NavLink
                        key={section.id}
                        to={section.to(workspaceId)}
                        className={({ isActive }) =>
                            cn(
                                'inline-flex h-8 shrink-0 items-center rounded-md border border-transparent px-3 font-medium text-text-muted transition-colors hover:text-text max-md:h-touch',
                                isActive && 'border-border bg-surface-raised text-text',
                                focusRing,
                            )
                        }
                    >
                        {section.label}
                    </NavLink>
                ))}
            </nav>
            <Outlet />
        </div>
    );
}

/** The settings pages' date column; the one formatter lives in `lib/format`. */
export { formatDate } from '../../../lib/format';
