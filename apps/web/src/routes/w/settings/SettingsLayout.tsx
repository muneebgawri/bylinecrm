import type { Capability } from '@bylinecrm/shared';
import { PageHeader, cn, focusRing } from '@bylinecrm/ui';
import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { can, useMembership } from '../../../auth/capabilities';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';

/** Each section and the capability its writes need; a member sees only the sections they can use (FR-CRMS-UI-6). */
const SECTIONS: readonly { id: string; label: string; to: (workspaceId: string) => string; requires: Capability }[] = [
    { id: 'members', label: 'Members', to: paths.settingsMembers, requires: 'workspace:admin' },
    { id: 'roles', label: 'Roles', to: paths.settingsRoles, requires: 'workspace:admin' },
    { id: 'api-keys', label: 'API keys', to: paths.settingsApiKeys, requires: 'workspace:admin' },
    { id: 'invites', label: 'Invites', to: paths.settingsInvites, requires: 'workspace:admin' },
    { id: 'pipelines', label: 'Pipelines', to: paths.settingsPipelines, requires: 'pipeline:configure' },
    { id: 'custom-fields', label: 'Custom fields', to: paths.settingsCustomFields, requires: 'workspace:admin' },
    // Readable by every member who reads records — the postal address and unsubscribe wording every
    // outreach email carries; editable by an admin on the page itself.
    { id: 'mail', label: 'Mail', to: paths.settingsMail, requires: 'record:read' },
];

/** Workspace settings: a section row, then the section's table. The server is still the gate on every write. */
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
                subtitle="Who is in the workspace and what they may do, the pipelines deals move through, the fields records carry, and how its mail is signed."
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
