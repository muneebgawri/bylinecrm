import type { DomainEvent, RecordTarget } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { recordTargetsForPeople } from './matching';
import { emailSummaryOf } from './summary';

/**
 * After participants are re-pointed (a person gained, lost, deleted or restored an address), brings
 * each affected message's timeline entries in line with who it concerns now (P2-2):
 *
 * - entries on records the message no longer concerns are removed (through the one function that
 *   may remove synced mail's entries);
 * - each person newly linked to the message gets an `email.linked` event whose `targets` are that
 *   person's records not already carrying the message — the timeline writes the same entries an
 *   import would, exactly once per record.
 *
 * Runs in the caller's transaction; returns the events to publish once it commits.
 */
export async function reconcileMessageTargets(
    tx: WorkspaceClient,
    workspaceId: string,
    messageIds: readonly string[],
): Promise<DomainEvent[]> {
    if (messageIds.length === 0) return [];
    const ids = [...new Set(messageIds)];
    const messages = await tx.mailMessage.findMany({
        where: { id: { in: ids } },
        include: { participants: { select: { personId: true } } },
        orderBy: { id: 'asc' },
    });
    const existing = await tx.timelineActivity.findMany({
        where: { linkedType: 'email', linkedId: { in: ids } },
        select: { linkedId: true, targetType: true, targetId: true },
    });

    const removeLinked: string[] = [];
    const removeTargets: string[] = [];
    const events: DomainEvent[] = [];
    const key = (t: RecordTarget) => `${t.type}:${t.id}`;

    for (const message of messages) {
        const people = [...new Set(message.participants.map((p) => p.personId))].filter(
            (id): id is string => id !== null,
        );
        const desired = new Set((await recordTargetsForPeople(tx, people)).map(key));
        const present = new Set(
            existing
                .filter((e) => e.linkedId === message.id)
                .map((e) => key({ type: e.targetType as RecordTarget['type'], id: e.targetId })),
        );
        for (const entry of existing.filter((e) => e.linkedId === message.id)) {
            if (!desired.has(key({ type: entry.targetType as RecordTarget['type'], id: entry.targetId }))) {
                removeLinked.push(message.id);
                removeTargets.push(entry.targetId);
                present.delete(key({ type: entry.targetType as RecordTarget['type'], id: entry.targetId }));
            }
        }
        for (const personId of people) {
            if (present.has(`person:${personId}`)) continue;
            const targets = (await recordTargetsForPeople(tx, [personId])).filter((t) => !present.has(key(t)));
            if (targets.length === 0) continue;
            for (const t of targets) present.add(key(t));
            events.push({
                type: 'email.linked',
                object: 'email',
                workspaceId,
                actor: { kind: 'sync', id: message.mailboxId },
                occurredAt: new Date().toISOString(),
                recordId: message.id,
                targets,
                email: emailSummaryOf(message),
                link: { personId },
            });
        }
    }
    if (removeLinked.length > 0) {
        await tx.$queryRaw`SELECT delete_email_timeline_entries(${removeLinked}::uuid[], ${removeTargets}::uuid[])`;
    }
    return events;
}
