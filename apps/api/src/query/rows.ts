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

/** How many rows match, counting at most `take` when given (a capped total stops early). */
export function countRows(
    tx: WorkspaceClient,
    object: RecordObject,
    where: CompiledWhere,
    take?: number,
): Promise<number> {
    switch (object) {
        case 'person': {
            const args: Prisma.PersonCountArgs = { where: where as Prisma.PersonWhereInput };
            if (take !== undefined) args.take = take;
            return tx.person.count(args);
        }
        case 'company': {
            const args: Prisma.CompanyCountArgs = { where: where as Prisma.CompanyWhereInput };
            if (take !== undefined) args.take = take;
            return tx.company.count(args);
        }
        case 'opportunity': {
            const args: Prisma.OpportunityCountArgs = { where: where as Prisma.OpportunityWhereInput };
            if (take !== undefined) args.take = take;
            return tx.opportunity.count(args);
        }
    }
}

/** The ids of the rows that match, in the list's order, at most `take` — what a bulk action acts on. */
export async function rowIds(
    tx: WorkspaceClient,
    object: RecordObject,
    where: CompiledWhere,
    orderBy: CompiledOrderBy,
    take: number,
): Promise<string[]> {
    const args = { where, orderBy, take, select: { id: true } };
    let rows: { id: string }[];
    switch (object) {
        case 'person':
            rows = await tx.person.findMany(args as Prisma.PersonFindManyArgs);
            break;
        case 'company':
            rows = await tx.company.findMany(args as Prisma.CompanyFindManyArgs);
            break;
        case 'opportunity':
            rows = await tx.opportunity.findMany(args as Prisma.OpportunityFindManyArgs);
            break;
    }
    return rows.map((r) => r.id);
}

/** A field's value on a row: the column, the value at a path into a JSON column, or the key of the `custom` object. */
export function cellOf(row: RecordRow, field: ResolvedField): unknown {
    if (field.storage === 'column') return row[field.column];
    const [column, path] = field.storage === 'json' ? [field.column, field.path] : ['custom', [field.key]];
    return path.reduce<unknown>(
        (at, key) => (at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined),
        row[column],
    );
}
