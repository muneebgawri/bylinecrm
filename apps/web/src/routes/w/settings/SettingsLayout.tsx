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
    // Records held by someone other than their company's owner (OWN-2): a manager's to resolve.
    { id: 'ownership', label: 'Ownership', to: paths.settingsOwnership, requires: 'record:transfer' },
    // What the recipient guard refused or let a manager through (GUARD-1): reviewers mark events legitimate.
    { id: 'guardrails', label: 'Guardrails', to: paths.settingsGuardrails, requires: 'guardrail:review' },
    // Readable by every member who reads records — the postal address and unsubscribe wording every
    // outreach email carries; editable by an admin on the page itself.
    { id: 'mail', label: 'Mail', to: paths.settingsMail, requires: 'record:read' },
    // Every member signs their own mailboxes (#193); an admin also sets the logo and the workspace's.
    { id: 'signatures', label: 'Signatures', to: paths.settingsSignatures, requires: 'mailbox:read' },
    // The workspace's own Google OAuth client (D-237); a member who is not an admin reads its status on Mailboxes.
    { id: 'google', label: 'Google', to: paths.settingsGoogle, requires: 'workspace:admin' },
    // Addresses the workspace never mails (P3-1): the other half of outreach, so outreach's capability.
    { id: 'suppression', label: 'Suppression', to: paths.settingsSuppression, requires: 'outreach:write' },
    // Where sequences may enrol (FR-CRMS-12, #141): read with outreach rights; an admin changes it.
    { id: 'region-policy', label: 'Region policy', to: paths.settingsRegionPolicy, requires: 'outreach:write' },
    // What verification does before an enrolment and a send (P3-5): read with outreach rights; an admin sets the age.
    { id: 'verification', label: 'Verification', to: paths.settingsVerification, requires: 'outreach:write' },
    // What enrichment asks about records (P4-2): read with record rights; an admin changes it.
    { id: 'enrichment', label: 'Enrichment', to: paths.settingsEnrichment, requires: 'record:read' },
    // The short-link domain tracked links go through (P3-4): read with outreach rights; an admin sets it.
    { id: 'tracking', label: 'Tracking', to: paths.settingsTracking, requires: 'outreach:write' },
    // The booking site whose bookings count as members' meetings (CAL-2): its hook's URL and secret are an admin's.
    { id: 'slotline', label: 'Slotline', to: paths.settingsSlotline, requires: 'workspace:admin' },
    // Where invoices on deals are verified (INV-1): its token and hook secret are an admin's.
    { id: 'newswireos', label: 'NewswireOS', to: paths.settingsNewswireos, requires: 'workspace:admin' },
    // Where BylineAI's leads come in (BYL-1): the webhook's secret and the round-robin list are an admin's.
    { id: 'byline', label: 'BylineAI', to: paths.settingsByline, requires: 'workspace:admin' },
    // SMTP2Go pool mailbox (TRANS-1): the pool's second transport — its API key and hook secret are an admin's.
    { id: 'smtp2go', label: 'SMTP2Go', to: paths.settingsSmtp2Go, requires: 'workspace:admin' },
    // The Twenty importer (P4-4): it writes every object the workspace has, so an admin's.
    { id: 'import-twenty', label: 'Import from Twenty', to: paths.settingsImportTwenty, requires: 'workspace:admin' },
    // The Bigin importer (BIGIN-1): one-way sync from Zoho Bigin, an admin's like the Twenty importer.
    { id: 'import-bigin', label: 'Import from Bigin', to: paths.settingsImportBigin, requires: 'workspace:admin' },
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
        const show = () =>
            nav.current
                ?.querySelector('[aria-current="page"]')
                ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        show();
        // Widths change when the web font arrives; measure again then, so the position is the same every time.
        let live = true;
        void document.fonts?.ready.then(() => {
            if (live) show();
        });
        return () => {
            live = false;
        };
    }, [pathname, sections.length]);
    return (
        <div className="p-7">
            <PageHeader
                title="Settings"
                subtitle="Who is in the workspace and what they may do, the pipelines deals move through, the fields records carry, how its mail is signed, the Google client its mailboxes connect through, the addresses it never mails, the regions its outreach may reach, how long an address's verification stands, what enrichment looks up, the domain its tracked links go through, and the Twenty workspace and Bigin account it imports from."
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
