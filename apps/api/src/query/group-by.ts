import { BadRequestException } from '@nestjs/common';
import type { RecordObject } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import type { CompiledWhere } from './compile-filter';
import { fieldNamed, type ResolvedField } from './fields';
import type { Group } from './responses';
export type { Group } from './responses';

/** The money field a group sums, per object; people carry none. */
const SUM_COLUMN: Readonly<Partial<Record<RecordObject, { column: 'arrMinor' | 'amountMinor'; field: string }>>> = {
    company: { column: 'arrMinor', field: 'arr' },
    opportunity: { column: 'amountMinor', field: 'amount' },
};

/**
 * Counts (and sums) the rows of a filtered list per value of one groupable field, in the
 * caller's transaction so the row-level policies — workspace and owner scope — apply exactly as
 * to the list itself. Grouping is over a column: a custom field has no index to group by and
 * is refused as not groupable, which `fieldNamed` + the descriptor say in one place.
 */
export async function groupRows(
    tx: WorkspaceClient,
    object: RecordObject,
    fields: readonly ResolvedField[],
    fieldName: string,
    where: CompiledWhere,
): Promise<Group[]> {
    const field = fieldNamed(fields, fieldName, 'groupBy');
    if (!field.groupable || field.storage !== 'column') {
        throw new BadRequestException(`groupBy: ${fieldName} cannot be grouped by`);
    }
    const sum = SUM_COLUMN[object];
    const rows = await grouped(tx, object, field.column, where, sum?.column);
    return rows.map((r) => ({
        value: r.value,
        count: r.count,
        ...(sum ? { sum: { amountMinor: Number(r.sum ?? 0), field: sum.field } } : {}),
    }));
}

interface GroupedRow {
    value: unknown;
    count: number;
    sum: bigint | null;
}

/** The three models' `groupBy` calls, each typed by its own delegate; the column names are the resolver's, never input. */
async function grouped(
    tx: WorkspaceClient,
    object: RecordObject,
    column: string,
    where: CompiledWhere,
    sumColumn: 'arrMinor' | 'amountMinor' | undefined,
): Promise<GroupedRow[]> {
    switch (object) {
        case 'person': {
            const by = column as Prisma.PersonScalarFieldEnum;
            const rows = await tx.person.groupBy({
                by: [by],
                where: where as Prisma.PersonWhereInput,
                _count: { _all: true },
            });
            return rows.map((r) => ({ value: (r as Record<string, unknown>)[by], count: r._count._all, sum: null }));
        }
        case 'company': {
            const by = column as Prisma.CompanyScalarFieldEnum;
            const rows = await tx.company.groupBy({
                by: [by],
                where: where as Prisma.CompanyWhereInput,
                _count: { _all: true },
                _sum: { arrMinor: true },
            });
            return rows.map((r) => ({
                value: (r as Record<string, unknown>)[by],
                count: r._count._all,
                sum: sumColumn ? r._sum.arrMinor : null,
            }));
        }
        case 'opportunity': {
            const by = column as Prisma.OpportunityScalarFieldEnum;
            const rows = await tx.opportunity.groupBy({
                by: [by],
                where: where as Prisma.OpportunityWhereInput,
                _count: { _all: true },
                _sum: { amountMinor: true },
            });
            return rows.map((r) => ({
                value: (r as Record<string, unknown>)[by],
                count: r._count._all,
                sum: sumColumn ? r._sum.amountMinor : null,
            }));
        }
    }
}
