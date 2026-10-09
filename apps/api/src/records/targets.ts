import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { RECORD_OBJECTS, type RecordObject, type RecordTarget } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `person:<uuid>` as a query string carries a target; anything else is a `400`. */
export function parseTarget(raw: string): RecordTarget {
    const [type, id] = raw.split(':');
    if (!type || !id || !(RECORD_OBJECTS as readonly string[]).includes(type) || !UUID.test(id)) {
        throw new BadRequestException(`target is <${RECORD_OBJECTS.join('|')}>:<uuid>`);
    }
    return { type: type as RecordObject, id };
}

/** The same target listed twice is listed once; order is kept. */
export function dedupeTargets(targets: readonly RecordTarget[]): RecordTarget[] {
    const seen = new Set<string>();
    return targets.filter((t) => {
        const key = `${t.type}:${t.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Which of `targets` are live records the caller can see. The lookups run in the caller's
 * transaction, so the workspace policy and — for an own-scoped caller — the restrictive owner
 * policy decide what "can see" means; this function adds nothing of its own. One definition:
 * writing a target, reading a note or task, and reading an attachment all ask this.
 */
export async function readableTargets(tx: WorkspaceClient, targets: readonly RecordTarget[]): Promise<RecordTarget[]> {
    const byType = new Map<RecordObject, string[]>();
    for (const t of targets) byType.set(t.type, [...(byType.get(t.type) ?? []), t.id]);
    const live = new Set<string>();
    for (const [type, ids] of byType) {
        const rows = await liveIds(tx, type, ids);
        for (const id of rows) live.add(`${type}:${id}`);
    }
    return targets.filter((t) => live.has(`${t.type}:${t.id}`));
}

async function liveIds(tx: WorkspaceClient, type: RecordObject, ids: string[]): Promise<string[]> {
    const where = { id: { in: ids }, deletedAt: null };
    const select = { id: true };
    switch (type) {
        case 'person':
            return (await tx.person.findMany({ where, select })).map((r) => r.id);
        case 'company':
            return (await tx.company.findMany({ where, select })).map((r) => r.id);
        case 'opportunity':
            return (await tx.opportunity.findMany({ where, select })).map((r) => r.id);
    }
}

/**
 * Every target a write names must be a live record the caller can see — `422` otherwise, naming
 * the first one that is not. A target outside the caller's scope reads as missing here for the
 * same reason a record does on its own route (P1-1a: no existence leak).
 */
export async function assertTargetsReadable(tx: WorkspaceClient, targets: readonly RecordTarget[]): Promise<void> {
    if (targets.length === 0) throw new UnprocessableEntityException('at least one target is required');
    const readable = await readableTargets(tx, targets);
    if (readable.length !== targets.length) {
        const missing = targets.find((t) => !readable.some((r) => r.type === t.type && r.id === t.id))!;
        throw new UnprocessableEntityException(`target ${missing.type}:${missing.id} not found`);
    }
}

/** Whether the caller can see at least one of a thing's targets — the visibility rule for notes, tasks and files. */
export async function anyTargetReadable(tx: WorkspaceClient, targets: readonly RecordTarget[]): Promise<boolean> {
    return (await readableTargets(tx, targets)).length > 0;
}

/** The join rows that attach a note or task to its targets, as Prisma's nested `create` takes them. */
export function targetRows(workspaceId: string, targets: readonly RecordTarget[]) {
    return targets.map((t) => ({ workspaceId, targetType: t.type, targetId: t.id }));
}

export function targetKey(t: RecordTarget): string {
    return `${t.type}:${t.id}`;
}
