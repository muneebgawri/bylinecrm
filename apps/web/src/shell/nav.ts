import type { Capability } from '@bylinecrm/shared';
import {
    Activity,
    BarChart3,
    Building2,
    CalendarDays,
    FileText,
    Handshake,
    Inbox,
    LayoutDashboard,
    ListOrdered,
    Settings,
    Target,
    Users,
    UsersRound,
    type LucideIcon,
} from 'lucide-react';
import { paths, withCreate } from '../routes/paths';
import { LEADS_FILTER } from '../routes/w/leads/leadsFilter';

/**
 * The sidebar's contents, once: four groups with 12px labels (mockup v3). Every item names the
 * capability that shows it (FR-CRMS-UI-6; an item the member cannot use is absent) and its
 * go-to chord. The ⌘K "Go to" group and the shortcuts sheet are generated from this list.
 */
export interface NavItem {
    id: string;
    label: string;
    icon: LucideIcon;
    to: (workspaceId: string) => string;
    /** Absent means every member sees it. */
    requires?: Capability;
    /** A `g x` chord. */
    shortcut?: string;
    /** Right-aligned: a count (`{ count }`) or an attention badge (`{ badge }`). Filled by pages later. */
    badge?: 'count' | 'attention';
    /** Sub-pages under the item: the sidebar shows them beneath it when the section is open. */
    children?: readonly NavChild[];
}

export interface NavChild {
    id: string;
    label: string;
    to: (workspaceId: string) => string;
    requires?: Capability;
}

export interface NavGroup {
    label: string;
    items: readonly NavItem[];
}

export const NAV: readonly NavGroup[] = [
    {
        label: 'Overview',
        items: [
            { id: 'home', label: 'Dashboard', icon: LayoutDashboard, to: paths.home, shortcut: 'g h' },
            { id: 'reports', label: 'Reports', icon: BarChart3, to: paths.reports, shortcut: 'g r' },
        ],
    },
    {
        label: 'CRM',
        items: [
            {
                id: 'leads',
                label: 'Leads',
                icon: Target,
                to: paths.leads,
                requires: 'record:read',
                shortcut: 'g l',
                children: [
                    { id: 'leads.pipeline', label: 'Pipeline', to: paths.leads },
                    {
                        id: 'leads.all',
                        label: 'All leads',
                        to: (ws) => `${paths.people(ws)}?filter=${LEADS_FILTER}`,
                    },
                    {
                        id: 'leads.new',
                        label: 'Add lead',
                        to: (ws) => withCreate(paths.people(ws)),
                        requires: 'record:write',
                    },
                ],
            },
            {
                id: 'people',
                label: 'People',
                icon: Users,
                to: paths.people,
                requires: 'record:read',
                shortcut: 'g p',
                children: [
                    { id: 'people.all', label: 'All people', to: paths.people },
                    {
                        id: 'people.new',
                        label: 'Add person',
                        to: (ws) => withCreate(paths.people(ws)),
                        requires: 'record:write',
                    },
                ],
            },
            {
                id: 'companies',
                label: 'Companies',
                icon: Building2,
                to: paths.companies,
                requires: 'record:read',
                shortcut: 'g c',
                children: [
                    { id: 'companies.all', label: 'All companies', to: paths.companies },
                    {
                        id: 'companies.new',
                        label: 'Add company',
                        to: (ws) => withCreate(paths.companies(ws)),
                        requires: 'record:write',
                    },
                ],
            },
            {
                id: 'deals',
                label: 'Deals',
                icon: Handshake,
                to: paths.deals,
                requires: 'deal:read',
                shortcut: 'g d',
                children: [
                    { id: 'deals.board', label: 'Pipeline', to: (ws) => `${paths.deals(ws)}?show=board` },
                    { id: 'deals.list', label: 'All deals', to: (ws) => `${paths.deals(ws)}?show=list` },
                    {
                        id: 'deals.new',
                        label: 'Add deal',
                        to: (ws) => withCreate(paths.deals(ws)),
                        requires: 'deal:edit',
                    },
                ],
            },
        ],
    },
    {
        label: 'Outreach',
        items: [
            {
                id: 'sequences',
                label: 'Sequences',
                icon: ListOrdered,
                to: paths.sequences,
                requires: 'sequence:write',
                shortcut: 'g s',
            },
            {
                id: 'templates',
                label: 'Templates',
                icon: FileText,
                to: paths.templates,
                requires: 'template:read',
                shortcut: 'g t',
            },
            {
                id: 'mailboxes',
                label: 'Mailboxes',
                icon: Inbox,
                to: paths.mailboxes,
                requires: 'mailbox:read',
                shortcut: 'g m',
            },
        ],
    },
    {
        label: 'Engagement',
        items: [
            {
                id: 'activities',
                label: 'Activities',
                icon: Activity,
                to: paths.activities,
                requires: 'record:read',
                shortcut: 'g a',
            },
            {
                id: 'calendar',
                label: 'Calendar',
                icon: CalendarDays,
                to: paths.calendar,
                requires: 'record:read',
                shortcut: 'g k',
            },
        ],
    },
    {
        label: 'Workspace',
        items: [
            { id: 'team', label: 'Team', icon: UsersRound, to: paths.team, requires: 'record:read' },
            {
                id: 'settings',
                label: 'Settings',
                icon: Settings,
                to: paths.settings,
                requires: 'workspace:admin',
                shortcut: 'g ,',
            },
        ],
    },
];

/** Every item, flat, for the palette and the shortcuts sheet. */
export const NAV_ITEMS: readonly NavItem[] = NAV.flatMap((group) => group.items);
