import type { LabelledTarget, RecordObject } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/**
 * The names of the records tasks are about (#192): a person's name (else their address), a
 * company's, a deal's — one query per kind, whatever the number of tasks. A record the caller may
 * not read (or that is gone) keeps its place with a plain label, never its name.
 */
export async function labelTargets(
    tx: WorkspaceClient,
    targets: readonly { targetType: string; targetId: string }[],
): Promise<Map<string, string>> {
    const ids = (type: RecordObject) => [
        ...new Set(targets.filter((t) => t.targetType === type).map((t) => t.targetId)),
    ];
    const [people, companies, deals] = await Promise.all([
        tx.person.findMany({
            where: { id: { in: ids('person') }, deletedAt: null },
            select: { id: true, nameFirst: true, nameLast: true, emailPrimary: true },
        }),
        tx.company.findMany({
            where: { id: { in: ids('company') }, deletedAt: null },
            select: { id: true, name: true },
        }),
        tx.opportunity.findMany({
            where: { id: { in: ids('opportunity') }, deletedAt: null },
            select: { id: true, name: true },
        }),
    ]);
    const labels = new Map<string, string>();
    for (const p of people) {
        labels.set(`person:${p.id}`, `${p.nameFirst} ${p.nameLast}`.trim() || p.emailPrimary || 'Unnamed person');
    }
    for (const c of companies) labels.set(`company:${c.id}`, c.name);
    for (const d of deals) labels.set(`opportunity:${d.id}`, d.name);
    return labels;
}

const FALLBACK: Record<RecordObject, string> = { person: 'A person', company: 'A company', opportunity: 'A deal' };

export function labelled(
    targets: readonly { targetType: string; targetId: string }[],
    labels: ReadonlyMap<string, string>,
): LabelledTarget[] {
    return targets.map((t) => {
        const type = t.targetType as RecordObject;
        return { type, id: t.targetId, label: labels.get(`${type}:${t.targetId}`) ?? FALLBACK[type] };
    });
}
