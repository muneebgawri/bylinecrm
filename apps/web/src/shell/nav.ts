import type { Capability } from '@bylinecrm/shared';
import {
    BarChart3,
    Building2,
    FileText,
    Handshake,
    Inbox,
    LayoutDashboard,
    ListOrdered,
    Settings,
    Users,
    UsersRound,
    type LucideIcon,
} from 'lucide-react';
import { paths } from '../routes/paths';

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
            { id: 'people', label: 'People', icon: Users, to: paths.people, requires: 'record:read', shortcut: 'g p' },
            {
                id: 'companies',
                label: 'Companies',
                icon: Building2,
                to: paths.companies,
                requires: 'record:read',
                shortcut: 'g c',
            },
            { id: 'deals', label: 'Deals', icon: Handshake, to: paths.deals, requires: 'deal:read', shortcut: 'g d' },
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
        label: 'Workspace',
        items: [
            { id: 'team', label: 'Team', icon: UsersRound, to: paths.team, requires: 'workspace:admin' },
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
