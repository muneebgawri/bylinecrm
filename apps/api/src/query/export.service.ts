import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { EXPORT_MAX_ROWS, EXPORT_PAGE_SIZE, type RecordObject } from '@bylinecrm/shared';
import type { Writable } from 'node:stream';
import { DomainEvents } from '../events/domain-events.service';
import { recordGuardrailEvents, type NewGuardrailEvent } from '../guardrails/record';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { CustomFieldsService } from '../records/custom-fields/custom-fields.service';
import { CSV_BOM, csvRow } from './csv';
import { fieldNamed, type ResolvedField } from './fields';
import { listScope, type RawQuery } from './query.service';
import { cellOf, countRows, fetchRows } from './rows';

export interface ExportRequest extends RawQuery {
    /** Field names, comma-separated; every standard field when absent. */
    columns?: string | undefined;
}

/**
 * Streams a filtered list as CSV: the same filter, sort, search and owner scope as the list — and, for a
 * member whose role lacks `record:export_all` (GUARD-1), only the records they own,
 * one page of `EXPORT_PAGE_SIZE` rows at a time, never the whole result in memory. A result
 * larger than `EXPORT_MAX_ROWS` is refused before the first row (`413`) rather than cut short —
 * a truncated export that looks complete is worse than none.
 */
@Injectable()
export class ExportService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly customFields: CustomFieldsService,
        private readonly events: DomainEvents,
    ) {}

    async writeCsv(object: RecordObject, request: ExportRequest, out: Writable): Promise<void> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const scope = await listScope(tx, context, this.customFields, object, request, false);
            const { plan } = scope;
            // GUARD-1 (FR-CRMS-21): a member exports their own records unless their role has `record:export_all`.
            const own = !!context.memberId && !context.capabilities.has('record:export_all');
            const where = own ? { AND: [scope.where, { ownerId: context.memberId }] } : scope.where;
            const columns = chosenColumns(plan.fields, request.columns);

            const total = await countRows(tx, object, where);
            if (total > EXPORT_MAX_ROWS) {
                throw new PayloadTooLargeException(
                    `this export would hold ${total} rows; the limit is ${EXPORT_MAX_ROWS}. Narrow the filter or export in parts.`,
                );
            }

            // GUARD-1b: the export audit — who, which object, under which filter, how many rows, own or all —
            // kept with the guardrail events (and announced as `guardrail.recorded`) before the first row goes.
            await recordGuardrailEvents(tx, this.events, context, [exportAudit(context, object, request, total, own)]);

            await write(out, CSV_BOM + csvRow(columns.map((c) => c.label)));
            let cursor: string | undefined;
            for (;;) {
                const rows = await fetchRows(tx, object, {
                    where,
                    orderBy: plan.orderBy,
                    cursor,
                    take: EXPORT_PAGE_SIZE,
                });
                for (const row of rows) await write(out, csvRow(columns.map((c) => cellOf(row, c))));
                if (rows.length < EXPORT_PAGE_SIZE) break;
                cursor = rows[rows.length - 1]!.id;
            }
        });
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('ExportService is used inside a workspace scope');
        return context;
    }
}

/** The columns to write: the named ones in the order named, or every standard field. */
function chosenColumns(fields: readonly ResolvedField[], raw: string | undefined): ResolvedField[] {
    if (raw === undefined || raw === '') return fields.filter((f) => f.storage !== 'custom');
    const names = raw.split(',').map((n) => n.trim());
    if (new Set(names).size !== names.length) throw new BadRequestException('columns: a field is named twice');
    return names.map((n) => fieldNamed(fields, n, 'columns'));
}

/** Respects back-pressure: waits for `drain` when the socket's buffer is full. */
function write(out: Writable, chunk: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (out.write(chunk)) return resolve();
        const onDrain = () => {
            out.off('error', onError);
            resolve();
        };
        const onError = (error: Error) => {
            out.off('drain', onDrain);
            reject(error);
        };
        out.once('drain', onDrain);
        out.once('error', onError);
    });
}

const PLURAL: Readonly<Record<RecordObject, string>> = { person: 'people', company: 'companies', opportunity: 'deals' };
const FILTER_DETAIL_MAX = 2000;

/** One export, as the Guardrails page and the `guardrail.recorded` webhook read it. Never a row of the CSV. */
function exportAudit(
    context: WorkspaceRunContext,
    object: RecordObject,
    request: ExportRequest,
    rows: number,
    own: boolean,
): NewGuardrailEvent {
    const filter = typeof request.filter === 'string' ? request.filter : JSON.stringify(request.filter ?? null);
    return {
        kind: 'record_export',
        outcome: 'allowed',
        severity: 'low',
        path: 'export',
        actorMemberId: context.memberId ?? null,
        message: `Exported ${rows} ${PLURAL[object]} (${own ? 'their own records' : 'all records'})`,
        detail: {
            object,
            scope: own ? 'own' : 'all',
            rows: String(rows),
            ...(request.filter !== undefined ? { filter: filter.slice(0, FILTER_DETAIL_MAX) } : {}),
            ...(request.q ? { q: request.q.slice(0, FILTER_DETAIL_MAX) } : {}),
            ...(request.view ? { view: request.view } : {}),
            ...(context.apiKeyId ? { apiKeyId: context.apiKeyId } : {}),
        },
    };
}
