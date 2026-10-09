import type { RecordObject } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import type { CompiledWhere } from './compile-filter';
import type { ResolvedField } from './fields';
import type { CompiledOrderBy } from './sort';

/** A record row as the export and the search read it: the model's scalars, by Prisma name. */
export type RecordRow = Record<string, unknown> & { id: string; custom?: unknown };

export interface RowPage {
    where: CompiledWhere;
    orderBy: CompiledOrderBy;
    cursor?: string | undefined;
    take: number;
}

/**
 * One page of one object's rows, in the caller's transaction. The three delegates are typed by
 * Prisma; the compiled `where`/`orderBy` meet those types here and nowhere else.
 */
export function fetchRows(tx: WorkspaceClient, object: RecordObject, page: RowPage): Promise<RecordRow[]> {
    const args = {
        where: page.where,
        orderBy: page.orderBy,
        take: page.take,
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    };
    switch (object) {
        case 'person':
            return tx.person.findMany(args as Prisma.PersonFindManyArgs) as Promise<RecordRow[]>;
        case 'company':
            return tx.company.findMany(args as Prisma.CompanyFindManyArgs) as Promise<RecordRow[]>;
        case 'opportunity':
            return tx.opportunity.findMany(args as Prisma.OpportunityFindManyArgs) as Promise<RecordRow[]>;
    }
}

export function countRows(tx: WorkspaceClient, object: RecordObject, where: CompiledWhere): Promise<number> {
    switch (object) {
        case 'person':
            return tx.person.count({ where: where as Prisma.PersonWhereInput });
        case 'company':
            return tx.company.count({ where: where as Prisma.CompanyWhereInput });
        case 'opportunity':
            return tx.opportunity.count({ where: where as Prisma.OpportunityWhereInput });
    }
}

/** A field's value on a row: the column, or the key of the `custom` object. */
export function cellOf(row: RecordRow, field: ResolvedField): unknown {
    if (field.storage === 'column') return row[field.column];
    const custom = row.custom as Record<string, unknown> | null | undefined;
    return custom?.[field.key];
}
