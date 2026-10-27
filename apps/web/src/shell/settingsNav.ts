import {
    ArrowDownUp,
    BadgeCheck,
    Ban,
    Bot,
    CalendarClock,
    Download,
    Globe,
    KeyRound,
    Mail,
    MailCheck,
    MailPlus,
    MousePointerClick,
    Newspaper,
    PenLine,
    Plug,
    RefreshCw,
    Send,
    ShieldAlert,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    UserCheck,
    Users,
    Workflow,
} from 'lucide-react';
import { paths } from '../routes/paths';
import type { NavGroup, NavItem } from './nav';

/** A settings section: a sidebar entry, plus the one line under its title on the page. */
export interface SettingsNavItem extends NavItem {
    /** One line under the section's title: what the page is for. */
    description: string;
    requires: NonNullable<NavItem['requires']>;
}

export interface SettingsNavGroup extends NavGroup {
    items: readonly SettingsNavItem[];
}

/**
 * Settings' sections, grouped, once: under `/settings` the sidebar shows these in place of the app's own
 * groups (the same entries, so the same collapse and drawer), and the settings page reads its title and
 * line from here. Each names the capability its writes need; a member sees only the sections they can use
 * (FR-CRMS-UI-6), and the server is still the gate on every write.
 */
export const SETTINGS_NAV: readonly SettingsNavGroup[] = [
    {
        label: 'Workspace',
        items: [
            {
                id: 'members',
                icon: Users,
                label: 'Members',
                description: 'Who is in the workspace, their role and which records they see.',
                to: paths.settingsMembers,
                requires: 'workspace:admin',
            },
            {
                id: 'roles',
                icon: ShieldCheck,
                label: 'Roles',
                description: 'What each role may do and which records it reaches.',
                to: paths.settingsRoles,
                requires: 'workspace:admin',
            },
            {
                id: 'invites',
                icon: MailPlus,
                label: 'Invites',
                description: 'Invitations to join the workspace that are not yet accepted.',
                to: paths.settingsInvites,
                requires: 'workspace:admin',
            },
            {
                id: 'api-keys',
                icon: KeyRound,
                label: 'API keys',
                description: 'Keys that let other systems call the API for this workspace.',
                to: paths.settingsApiKeys,
                requires: 'workspace:admin',
            },
        ],
    },
    {
        label: 'CRM',
        items: [
            {
                id: 'pipelines',
                icon: Workflow,
                label: 'Pipelines',
                description: 'The pipelines deals move through, their stages and the rules that move them.',
                to: paths.settingsPipelines,
                requires: 'pipeline:configure',
            },
            {
                id: 'custom-fields',
                icon: SlidersHorizontal,
                label: 'Custom fields',
                description: 'The fields people, companies and deals carry beyond the standard ones.',
                to: paths.settingsCustomFields,
                requires: 'workspace:admin',
            },
            // Records held by someone other than their company's owner (OWN-2): a manager's to resolve.
            {
                id: 'ownership',
                icon: UserCheck,
                label: 'Ownership',
                description: 'Records held by someone other than their company’s owner, to resolve.',
                to: paths.settingsOwnership,
                requires: 'record:transfer',
            },
            // CADENCE-1: lapsed leads rotate to the next rep; the cadence per stage, the reps, the dry run.
            {
                id: 'rotation',
                icon: RefreshCw,
                label: 'Rotation',
                description: 'How long a lead may go untouched at each stage before it rotates to the next rep.',
                to: paths.settingsRotation,
                requires: 'pipeline:cadence',
            },
            // Won deals as customers (#242): the outreach exclusions and what a won deal adds; an admin's.
            {
                id: 'customers',
                icon: BadgeCheck,
                label: 'Customers',
                description: 'What a won deal makes of its company and people, and what outreach leaves alone.',
                to: paths.settingsCustomers,
                requires: 'workspace:admin',
            },
            // What enrichment asks about records (P4-2): read with record rights; an admin changes it.
            {
                id: 'enrichment',
                icon: Sparkles,
                label: 'Enrichment',
                description: 'What enrichment looks up about people and companies.',
                to: paths.settingsEnrichment,
                requires: 'record:read',
            },
        ],
    },
    {
        label: 'Email & outreach',
        items: [
            // Readable by every member who reads records; editable by an admin on the page itself.
            {
                id: 'mail',
                icon: Mail,
                label: 'Mail',
                description: 'The postal address and unsubscribe wording every outreach email carries.',
                to: paths.settingsMail,
                requires: 'record:read',
            },
            // Every member signs their own mailboxes (#193); an admin also sets the logo and the workspace's.
            {
                id: 'signatures',
                icon: PenLine,
                label: 'Signatures',
                description: 'The signatures your mailboxes sign with, and the workspace’s own.',
                to: paths.settingsSignatures,
                requires: 'mailbox:read',
            },
            // Addresses the workspace never mails (P3-1): the other half of outreach, so outreach's capability.
            {
                id: 'suppression',
                icon: Ban,
                label: 'Suppression',
                description: 'Addresses and domains the workspace never mails.',
                to: paths.settingsSuppression,
                requires: 'outreach:write',
            },
            // Where sequences may enrol (FR-CRMS-12, #141): read with outreach rights; an admin changes it.
            {
                id: 'region-policy',
                icon: Globe,
                label: 'Region policy',
                description: 'The regions sequences may enrol people from.',
                to: paths.settingsRegionPolicy,
                requires: 'outreach:write',
            },
            // What verification does before an enrolment and a send (P3-5): an admin sets the age.
            {
                id: 'verification',
                icon: MailCheck,
                label: 'Verification',
                description: 'How addresses are checked before an enrolment or a send, and how long a check stands.',
                to: paths.settingsVerification,
                requires: 'outreach:write',
            },
            // The short-link domain tracked links go through (P3-4): read with outreach rights; an admin sets it.
            {
                id: 'tracking',
                icon: MousePointerClick,
                label: 'Tracking',
                description: 'The short-link domain clicks in outreach email are recorded through.',
                to: paths.settingsTracking,
                requires: 'outreach:write',
            },
            // What the recipient guard refused or let a manager through (GUARD-1): reviewers mark events legitimate.
            {
                id: 'guardrails',
                icon: ShieldAlert,
                label: 'Guardrails',
                description: 'Mail the recipient guard refused or let through, for review.',
                to: paths.settingsGuardrails,
                requires: 'guardrail:review',
            },
        ],
    },
    {
        label: 'Integrations',
        items: [
            // The workspace's own Google OAuth client (D-237); a member who is not an admin reads its status on Mailboxes.
            {
                id: 'google',
                icon: Plug,
                label: 'Google',
                description: 'The Google OAuth client the workspace’s mailboxes connect through.',
                to: paths.settingsGoogle,
                requires: 'workspace:admin',
            },
            // SMTP2Go pool mailbox (TRANS-1): the pool's second transport — its API key and hook secret are an admin's.
            {
                id: 'smtp2go',
                icon: Send,
                label: 'SMTP2Go',
                description: 'The SMTP2Go pool mailbox: its API key and delivery events.',
                to: paths.settingsSmtp2Go,
                requires: 'workspace:admin',
            },
            // The booking site whose bookings count as members' meetings (CAL-2): its hook's URL and secret are an admin's.
            {
                id: 'slotline',
                icon: CalendarClock,
                label: 'Slotline',
                description: 'The booking site whose bookings count as members’ meetings.',
                to: paths.settingsSlotline,
                requires: 'workspace:admin',
            },
            // Where invoices on deals are verified (INV-1): its token and hook secret are an admin's.
            {
                id: 'newswireos',
                icon: Newspaper,
                label: 'NewswireOS',
                description: 'Where invoices on deals are verified and clients are kept in step.',
                to: paths.settingsNewswireos,
                requires: 'workspace:admin',
            },
            // Where BylineAI's leads come in (BYL-1): the webhook's secret and the round-robin list are an admin's.
            {
                id: 'byline',
                icon: Bot,
                label: 'BylineAI',
                description: 'Where BylineAI’s leads come in and which reps they go to.',
                to: paths.settingsByline,
                requires: 'workspace:admin',
            },
        ],
    },
    {
        label: 'Import',
        items: [
            // The Twenty importer (P4-4): it writes every object the workspace has, so an admin's.
            {
                id: 'import-twenty',
                icon: Download,
                label: 'Twenty',
                description: 'Bring people, companies, deals and their history over from a Twenty workspace.',
                to: paths.settingsImportTwenty,
                requires: 'workspace:admin',
            },
            // The Bigin importer (BIGIN-1): one-way sync from Zoho Bigin, an admin's like the Twenty importer.
            {
                id: 'import-bigin',
                icon: ArrowDownUp,
                label: 'Bigin',
                description: 'Keep the workspace in step with a Zoho Bigin account, one way.',
                to: paths.settingsImportBigin,
                requires: 'workspace:admin',
            },
        ],
    },
];
