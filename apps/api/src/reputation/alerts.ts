import type { GuardrailEvent } from '@prisma/client';
import type { DomainEvents } from '../events/domain-events.service';
import { recordGuardrailEvents, reviewersIn, type NewGuardrailEvent } from '../guardrails/record';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { notify } from '../notifications/notify';

/** Who a reputation event tells: the mailbox's owner (the sender), and — at `high` — every reviewer. */
export interface AlertAudience {
    owner: string | null;
    reviewers: boolean;
}

/**
 * Writes one reputation guardrail event (REP-1) and tells its audience in the bell (`guardrail_alert`). With a
 * `dedupeKey` the event is written at most once per key (a second finding the same day writes and tells
 * nothing). Returns the event, or null when the key had been written already.
 */
export async function raiseAlert(
    tx: WorkspaceClient,
    events: DomainEvents,
    context: WorkspaceRunContext,
    row: NewGuardrailEvent,
    audience: AlertAudience,
): Promise<GuardrailEvent | null> {
    const told = new Set<string>();
    if (audience.owner) told.add(audience.owner);
    if (audience.reviewers) for (const id of await reviewersIn(tx, audience.owner)) told.add(id);
    const [event] = await recordGuardrailEvents(
        tx,
        events,
        context,
        [{ ...row, notifiedMemberIds: [...told] }],
        row.dedupeKey !== undefined && row.dedupeKey !== null,
    );
    if (!event) return null;
    await notify(tx, context.workspaceId, told, 'guardrail_alert', [{ type: 'guardrail', id: event.id }]);
    return event;
}

/** The UTC day of a moment, `YYYY-MM-DD` — what once-a-day keys are made of. */
export function utcDay(at: Date): string {
    return at.toISOString().slice(0, 10);
}
