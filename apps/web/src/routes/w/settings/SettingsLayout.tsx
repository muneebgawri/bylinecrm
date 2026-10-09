import { PageHeader, cn, focusRing } from '@bylinecrm/ui';
import { NavLink, Outlet } from 'react-router';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';

const SECTIONS = [
    { id: 'members', label: 'Members', to: paths.settingsMembers },
    { id: 'roles', label: 'Roles', to: paths.settingsRoles },
    { id: 'api-keys', label: 'API keys', to: paths.settingsApiKeys },
    { id: 'invites', label: 'Invites', to: paths.settingsInvites },
    { id: 'pipelines', label: 'Pipelines', to: paths.settingsPipelines },
] as const;

/** Workspace settings: a section row, then the section's table. Admin-only by the route guard. */
export function SettingsLayout() {
    const workspaceId = useWorkspaceId();
    return (
        <div className="p-7">
            <PageHeader
                title="Settings"
                subtitle="Who is in the workspace, what they may do, and the machines that may call it."
            />
            <nav aria-label="Settings sections" className="mb-4 flex gap-1">
                {SECTIONS.map((section) => (
                    <NavLink
                        key={section.id}
                        to={section.to(workspaceId)}
                        className={({ isActive }) =>
                            cn(
                                'h-8 rounded-md border border-transparent px-3 leading-8 font-medium text-text-muted transition-colors hover:text-text',
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

/** A relative time already formatted for the reader; dates arrive as ISO strings. */
export function formatDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}
