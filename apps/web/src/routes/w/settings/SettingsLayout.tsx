import { cn, focusRing } from '@bylinecrm/ui';
import { ChevronRight, SlidersHorizontal } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { can, useMembership } from '../../../auth/capabilities';
import { SETTINGS_NAV } from '../../../shell/settingsNav';
import { useWorkspaceId } from '../../params';
import { SETTINGS_SECTION_TITLE_ID } from './sectionTitle';

/**
 * Settings' frame: the page's own title, then a menu of sections on the left and the open
 * section on the right — its title, its one line, and the page. The app's sidebar stays as it is;
 * a member sees only the sections their role can use. A pipeline's own page (`pipelines/:id`)
 * is still the Pipelines section.
 */
export function SettingsLayout() {
    const workspaceId = useWorkspaceId();
    const membership = useMembership();
    const { pathname } = useLocation();
    const groups = SETTINGS_NAV.map((g) => ({
        ...g,
        items: g.items.filter((s) => can(membership, s.requires)),
    })).filter((g) => g.items.length > 0);
    const current = groups
        .flatMap((g) => g.items)
        .find((s) => pathname === s.to(workspaceId) || pathname.startsWith(`${s.to(workspaceId)}/`));

    return (
        <div className="flex flex-col gap-6 p-4 md:p-6">
            <header className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                    <SlidersHorizontal aria-hidden className="size-5 text-text-muted" />
                    <h1 className="m-0 text-2xl leading-tight font-semibold tracking-tight">Settings</h1>
                </div>
                <p className="m-0 text-sm text-text-muted">
                    Your workspace, its people, the pipeline, and how mail goes out.
                </p>
            </header>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                <nav
                    aria-label="Settings sections"
                    className="w-full shrink-0 overflow-x-auto rounded-xl border border-border bg-surface p-3 lg:sticky lg:top-6 lg:w-64 lg:overflow-visible"
                >
                    <div className="flex gap-4 lg:flex-col lg:gap-0">
                        {groups.map((group, i) => (
                            <div key={group.label} className={cn('min-w-max lg:min-w-0', i > 0 && 'lg:mt-4')}>
                                <p className="m-0 mb-1.5 px-2.5 text-[11px] font-semibold tracking-wide text-text-muted uppercase">
                                    {group.label}
                                </p>
                                <ul className="m-0 flex list-none gap-0.5 p-0 lg:flex-col">
                                    {group.items.map((item) => {
                                        const Icon = item.icon;
                                        return (
                                            <li key={item.id}>
                                                <NavLink
                                                    to={item.to(workspaceId)}
                                                    className={({ isActive }) =>
                                                        cn(
                                                            'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-text-muted transition-colors hover:bg-surface-raised hover:text-text',
                                                            isActive && 'bg-surface-raised font-medium text-text',
                                                            focusRing,
                                                        )
                                                    }
                                                >
                                                    {({ isActive }) => (
                                                        <>
                                                            <Icon aria-hidden className="size-4 shrink-0" />
                                                            <span className="truncate">{item.label}</span>
                                                            {isActive && (
                                                                <ChevronRight
                                                                    aria-hidden
                                                                    className="ml-auto hidden size-4 text-text-muted lg:block"
                                                                />
                                                            )}
                                                        </>
                                                    )}
                                                </NavLink>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        ))}
                    </div>
                </nav>
                <main className="flex min-w-0 flex-1 flex-col gap-6">
                    {current && (
                        <header className="flex flex-col gap-1.5 border-b border-border pb-4">
                            <h2
                                id={SETTINGS_SECTION_TITLE_ID}
                                className="m-0 text-xl leading-tight font-semibold tracking-tight"
                            >
                                {current.label}
                            </h2>
                            <p className="m-0 text-sm text-text-muted">{current.description}</p>
                        </header>
                    )}
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
