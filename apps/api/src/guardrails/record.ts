import type { DomainEvent } from '@bylinecrm/shared';
import type { GuardrailEvent, Prisma } from '@prisma/client';
import type { DomainEvents } from '../events/domain-events.service';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from '../records/actor';

/** A guardrail event to write: everything but the workspace, which the scope gives. */
export type NewGuardrailEvent = Omit<Prisma.GuardrailEventCreateManyInput, 'workspaceId'>;

/**
 * The one writer of `guardrail_events` (GUARD-1b): the rows, and a `guardrail.recorded` domain event for each in
 * the same transaction, so webhooks hear of exactly what the Guardrails page shows. `skipDuplicates` lets a
 * once-a-day event (its `dedupeKey`) be written idempotently; a row not written announces nothing.
 */
export async function recordGuardrailEvents(
    tx: WorkspaceClient,
    events: DomainEvents,
    context: WorkspaceRunContext,
    rows: readonly NewGuardrailEvent[],
    skipDuplicates = false,
): Promise<GuardrailEvent[]> {
    if (rows.length === 0) return [];
    const written = await tx.guardrailEvent.createManyAndReturn({
        data: rows.map((r) => ({ ...r, workspaceId: context.workspaceId })),
        skipDuplicates,
    });
    await events.recordAll(
        tx,
        written.map((row) => guardrailRecorded(context, row)),
    );
    return written;
}

function guardrailRecorded(context: WorkspaceRunContext, row: GuardrailEvent): DomainEvent {
    return {
        type: 'guardrail.recorded',
        object: 'guardrail',
        workspaceId: row.workspaceId,
        actor: actorOf(context),
        occurredAt: row.createdAt.toISOString(),
        recordId: row.id,
        guardrail: {
            kind: row.kind,
            outcome: row.outcome,
            severity: row.severity,
            path: row.path,
            actorMemberId: row.actorMemberId,
            ownerMemberId: row.ownerMemberId,
            personId: row.personId,
            companyId: row.companyId,
            address: row.address,
            message: row.message,
            detail: (row.detail ?? {}) as Record<string, string>,
        },
    };
}

/**
 * Who is told of a guardrail event for review: members whose role has `guardrail:review`, and admins — never
 * `except` (the member it is about).
 */
export async function reviewersIn(tx: WorkspaceClient, except: string | null): Promise<string[]> {
    return (
        await tx.workspaceMember.findMany({
            where: {
                leftAt: null,
                ...(except ? { id: { not: except } } : {}),
                role: {
                    OR: [
                        { isSystem: true, name: 'admin' },
                        { permissions: { some: { capability: 'guardrail:review' } } },
                    ],
                },
            },
            select: { id: true },
        })
    ).map((m) => m.id);
}
