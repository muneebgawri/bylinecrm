import { Outlet, useLocation } from 'react-router';
import { can, useMembership } from '../../../auth/capabilities';
import { SETTINGS_NAV } from '../../../shell/settingsNav';
import { useWorkspaceId } from '../../params';
import { SETTINGS_SECTION_TITLE_ID } from './sectionTitle';

/**
 * A settings page's frame: the sections are the sidebar's (`SETTINGS_NAV`), so this is the open section's
 * title and its one line, then the page, across the content area like every other page. A pipeline's own page (`pipelines/:id`)
 * is still the Pipelines section.
 */
export function SettingsLayout() {
    const workspaceId = useWorkspaceId();
    const membership = useMembership();
    const { pathname } = useLocation();
    const current = SETTINGS_NAV.flatMap((g) => g.items)
        .filter((s) => can(membership, s.requires))
        .find((s) => pathname === s.to(workspaceId) || pathname.startsWith(`${s.to(workspaceId)}/`));

    return (
        <div className="flex flex-col gap-6 p-4 md:p-6">
            {current && (
                <header className="flex flex-col gap-2 border-b border-border pb-5">
                    <div className="flex items-center gap-2">
                        <current.icon aria-hidden className="size-5 text-text-muted" />
                        <h1
                            id={SETTINGS_SECTION_TITLE_ID}
                            className="m-0 text-2xl leading-tight font-semibold tracking-tight"
                        >
                            {current.label}
                        </h1>
                    </div>
                    <p className="m-0 text-sm text-text-muted">{current.description}</p>
                </header>
            )}
            <Outlet />
        </div>
    );
}
