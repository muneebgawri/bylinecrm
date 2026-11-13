import type { WorkspaceRunContext } from '../infra/workspace-context';

/** Records written per transaction by a clean-up job: short transactions, and a failed chunk leaves the rest done. */
export const JOB_WRITE_CHUNK = 20;

/**
 * A clean-up job acting for the workspace, as an import: no caller, so the ownership rule's checks do not bind it,
 * and what it writes is not the owner working the record (OWN-2f reads an import's writes as nobody's work).
 */
export function importJobContext(workspaceId: string): WorkspaceRunContext {
    return { workspaceId, capabilities: new Set(), actor: { kind: 'import', id: null } };
}

/** A one-off process: no worker, relay or schedule of its own — the running API delivers what it records. */
export function quietWorkers(): void {
    for (const flag of [
        'WEBHOOK_WORKER',
        'MAIL_SYNC_WORKER',
        'MAIL_SEND_WORKER',
        'SEQUENCE_WORKER',
        'CALENDAR_SYNC_WORKER',
        'NOTIFICATIONS_WORKER',
        'TWENTY_IMPORT_WORKER',
        'ENRICHMENT_WORKER',
        'OUTBOX_RELAY',
        'TRANSACTIONAL_MAIL_RELAY',
        // The NewswireOS workers (invoice checks, ownership and deal-won pushes): a job's container would otherwise be
        // a second sender against NewswireOS's rate limit.
        'INVOICE_WORKER',
    ]) {
        process.env[flag] = '0';
    }
}
