import type { Capability } from '@bylinecrm/shared';
import { PageHeader, cn, focusRing } from '@bylinecrm/ui';
import { NavLink, Outlet } from 'react-router';
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
];

/** Workspace settings: a section row, then the section's table. The server is still the gate on every write. */
export function SettingsLayout() {
    const workspaceId = useWorkspaceId();
    const membership = useMembership();
    return (
        <div className="p-7">
            <PageHeader
                title="Settings"
                subtitle="Who is in the workspace and what they may do, the pipelines deals move through, and the fields records carry."
            />
            <nav aria-label="Settings sections" className="mb-4 flex gap-1 overflow-x-auto">
                {SECTIONS.filter((section) => can(membership, section.requires)).map((section) => (
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
