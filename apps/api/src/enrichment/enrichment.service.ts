import { Injectable, NotFoundException } from '@nestjs/common';
import {
    ENRICHMENT_HISTORY_LIMIT,
    type EnrichmentAnswerView,
    type EnrichmentFactKey,
    type EnrichmentHistoryView,
    type EnrichmentObject,
    type EnrichmentSource,
} from '@bylinecrm/shared';
import type { EnrichmentAnswer } from '@prisma/client';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { recordWhere } from '../records/record-scope';
import { EnrichmentQueue } from './enrichment-queue';

/**
 * A record's enrichment as a member sees it (P4-2): its answers, newest first, and whether a run is
 * queued; and _Enrich now_, which queues the record's job with `force` so every source is asked
 * again whatever its age. A record the caller cannot see is `404`, never a hint that it exists.
 */
@Injectable()
export class EnrichmentService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly queue: EnrichmentQueue,
    ) {}

    async history(object: EnrichmentObject, recordId: string): Promise<EnrichmentHistoryView> {
        const context = this.current();
        const answers = await this.rls.withWorkspace(async (tx) => {
            await this.visible(tx, context, object, recordId);
            return tx.enrichmentAnswer.findMany({
                where: { object, recordId },
                orderBy: [{ askedAt: 'desc' }, { field: 'asc' }],
                take: ENRICHMENT_HISTORY_LIMIT,
            });
        });
        return {
            object,
            recordId,
            lastAskedAt: answers[0]?.askedAt.toISOString() ?? null,
            pending: await this.queue.isPending(object, recordId),
            answers: answers.map(view),
        };
    }

    async request(object: EnrichmentObject, recordId: string): Promise<EnrichmentHistoryView> {
        const context = this.current();
        await this.rls.withWorkspace((tx) => this.visible(tx, context, object, recordId));
        await this.queue.enqueue({ workspaceId: context.workspaceId, object, recordId, force: true });
        return this.history(object, recordId);
    }

    private async visible(tx: WorkspaceClient, context: WorkspaceRunContext, object: EnrichmentObject, id: string) {
        const where = { id, ...recordWhere(context, false) };
        const row =
            object === 'company'
                ? await tx.company.findFirst({ where, select: { id: true } })
                : await tx.person.findFirst({ where, select: { id: true } });
        if (!row) throw new NotFoundException(`${object} not found`);
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('EnrichmentService is used inside a workspace scope');
        return context;
    }
}

function view(row: EnrichmentAnswer): EnrichmentAnswerView {
    return {
        id: row.id,
        object: row.object as EnrichmentObject,
        recordId: row.recordId,
        field: row.field as EnrichmentFactKey,
        source: row.source as EnrichmentSource,
        status: row.status,
        value: row.value,
        rank: row.rank,
        note: row.note,
        applied: row.applied,
        askedAt: row.askedAt.toISOString(),
    };
}
