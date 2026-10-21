import { Badge } from '@bylinecrm/ui';
import { useMailboxCoverage } from '../../../api/guardrails';

const STATUS_LABEL = {
    connected: 'Connected',
    reconnect_needed: 'Needs reconnecting',
    disconnected: 'Disconnected',
} as const;

/**
 * GUARD-2 (#203): members whose mail sync does not see — no connected mailbox (and, with #225, no Workspace
 * delegation). Poaching from such a mailbox is invisible to the detector, so this is the list to chase. Shown only
 * while someone is on it.
 */
export function UnsyncedMembers({ workspaceId }: { workspaceId: string }) {
    const coverage = useMailboxCoverage(workspaceId);
    const rows = (coverage.data ?? []).filter((m) => m.syncedVia === null);
    if (rows.length === 0) return null;
    return (
        <section aria-labelledby="unsynced-members-title" className="mb-4 rounded-md border border-border p-3">
            <h3 id="unsynced-members-title" className="m-0 mb-1 text-sm font-semibold">
                Members with no connected mailbox
            </h3>
            <p className="m-0 mb-2 text-[13px] text-text-muted">
                Mail they send outside the CRM is not seen, so it cannot be checked for other members’ leads.
            </p>
            <ul className="m-0 grid list-none gap-2 p-0">
                {rows.map((m) => (
                    <li key={m.memberId} className="flex flex-wrap items-center gap-2 text-[13px]">
                        <span className="font-medium">{m.name ?? m.email}</span>
                        <span className="text-text-muted">{m.email}</span>
                        <Badge status="neutral">{m.role}</Badge>
                        {m.mailboxes.map((b) => (
                            <Badge key={b.email} status="warning">
                                {b.email}: {STATUS_LABEL[b.status]}
                            </Badge>
                        ))}
                    </li>
                ))}
            </ul>
        </section>
    );
}
