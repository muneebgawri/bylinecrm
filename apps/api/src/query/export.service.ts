import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { EXPORT_MAX_ROWS, EXPORT_PAGE_SIZE, type RecordObject } from '@bylinecrm/shared';
import type { Writable } from 'node:stream';
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
 * Streams a filtered list as CSV: the same filter, sort, search and owner scope as the list,
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
    ) {}

    async writeCsv(object: RecordObject, request: ExportRequest, out: Writable): Promise<void> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const { plan, where } = await listScope(tx, context, this.customFields, object, request, false);
            const columns = chosenColumns(plan.fields, request.columns);

            const total = await countRows(tx, object, where);
            if (total > EXPORT_MAX_ROWS) {
                throw new PayloadTooLargeException(
                    `this export would hold ${total} rows; the limit is ${EXPORT_MAX_ROWS}. Narrow the filter or export in parts.`,
                );
            }

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
    if (raw === undefined || raw === '') return fields.filter((f) => f.storage === 'column');
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
