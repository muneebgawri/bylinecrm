import type { RecordTarget } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/** Mail about a record, as a filter on a row that names its person and deal (a send, a draft). */
export type AboutRecord = { personId: string | { in: string[] } } | { dealId: string };

/**
 * Which mail is about a record: a person's is theirs, a deal's is the deal's, and a company's is its people's.
 * Null for a company with nobody in it — nothing is about it. One reading for sends and drafts alike.
 */
export async function aboutRecord(tx: WorkspaceClient, target: RecordTarget): Promise<AboutRecord | null> {
    switch (target.type) {
        case 'person':
            return { personId: target.id };
        case 'opportunity':
            return { dealId: target.id };
        case 'company': {
            const people = await tx.person.findMany({
                where: { companyId: target.id, deletedAt: null },
                select: { id: true },
            });
            return people.length > 0 ? { personId: { in: people.map((p) => p.id) } } : null;
        }
    }
}
