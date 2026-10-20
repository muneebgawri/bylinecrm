import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
    customFieldKey,
    type FilterGroup,
    type FilterNode,
    isFilterGroup,
    groupNodes,
    type RecordObject,
    type SavedView,
    type ViewColumn,
    type ViewSort,
} from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { CustomFieldsService } from '../records/custom-fields/custom-fields.service';
import { stored } from '../records/references';
import { compileFilter } from '../query/compile-filter';
import { fieldNamed, resolveFields } from '../query/fields';
import { checkSortable } from '../query/sort';

export interface ViewInput {
    name?: string | undefined;
    icon?: string | null | undefined;
    filter?: FilterGroup | null | undefined;
    sorts?: ViewSort[] | undefined;
    columns?: ViewColumn[] | undefined;
    groupBy?: string | null | undefined;
    position?: number | undefined;
    isShared?: boolean | undefined;
}

type ViewRow = Prisma.SavedViewGetPayload<Record<string, never>>;

/**
 * Who sees a view: the workspace sees a shared one, its author sees their own. One predicate,
 * used by the list, the get, the record lists' `view=` lookup and the write checks.
 */
export function visibleViews(context: WorkspaceRunContext): Prisma.SavedViewWhereInput {
    return { OR: [{ isShared: true }, ...(context.memberId ? [{ ownerMemberId: context.memberId }] : [])] };
}

/**
 * A view the caller may use, for a record list's `view=` parameter, or `404` — a view outside
 * the caller's sight does not exist for them. A function rather than a provider so the record
 * services can call it without the records module depending on this one.
 */
export async function loadView(
    tx: WorkspaceClient,
    context: WorkspaceRunContext,
    object: RecordObject,
    id: string,
): Promise<SavedView> {
    const row = await tx.savedView.findFirst({ where: { id, object, ...visibleViews(context) } });
    if (!row) throw new NotFoundException('view not found');
    return view(row);
}

/**
 * A view as a caller who cannot see the `hidden` custom keys applies it: conditions, sorts and
 * columns on an admin-only field are dropped (a group left empty goes with them; a filter left
 * empty is none), and a grouping on one is cleared. A shared view an admin built over such a field
 * still loads for a member — over the fields they may see — instead of failing with `400`.
 */
export function withoutHiddenFields(saved: SavedView, hidden: ReadonlySet<string>): SavedView {
    if (hidden.size === 0) return saved;
    const isHidden = (field: string): boolean => {
        const key = customFieldKey(field);
        return key !== null && hidden.has(key);
    };
    const prune = (node: FilterNode): FilterNode | null => {
        if (!isFilterGroup(node)) return isHidden(node.field) ? null : node;
        const kept = groupNodes(node)
            .map(prune)
            .filter((n): n is FilterNode => n !== null);
        if (kept.length === 0) return null;
        return 'and' in node ? { and: kept } : { or: kept };
    };
    return {
        ...saved,
        filter: saved.filter ? (prune(saved.filter) as FilterGroup | null) : null,
        sorts: saved.sorts.filter((s) => !isHidden(s.field)),
        columns: saved.columns.filter((c) => !isHidden(c.field)),
        groupBy: saved.groupBy !== null && isHidden(saved.groupBy) ? null : saved.groupBy,
    };
}

/**
 * Saved views (PAR-056): a filter, sorts, columns and a grouping over one object. The filter and
 * the sorts are validated against the object's fields on every write, so a view can never be
 * saved with a condition the list would refuse; a field archived after the fact is reported when
 * the view is used (`400`, naming it), not silently dropped.
 */
@Injectable()
export class ViewsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly customFields: CustomFieldsService,
    ) {}

    list(object: RecordObject | undefined): Promise<SavedView[]> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.savedView.findMany({
                where: { ...(object ? { object } : {}), ...visibleViews(context) },
                orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            });
            const hidden = await this.hidden(tx, [...new Set(rows.map((r) => r.object))]);
            return rows.map((r) => withoutHiddenFields(view(r), hidden(r.object)));
        });
    }

    get(id: string): Promise<SavedView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const row = await find(tx, context, id);
            const hidden = await this.hidden(tx, [row.object]);
            return withoutHiddenFields(view(row), hidden(row.object));
        });
    }

    /** The admin-only keys the caller may not see on each of `objects` (none for an admin). */
    private async hidden(
        tx: WorkspaceClient,
        objects: readonly RecordObject[],
    ): Promise<(object: RecordObject) => ReadonlySet<string>> {
        const none: ReadonlySet<string> = new Set();
        if (!this.customFields.restricted()) return () => none;
        const sets = new Map<RecordObject, ReadonlySet<string>>();
        for (const o of objects) sets.set(o, await this.customFields.hiddenKeysWithin(tx, o));
        return (o) => sets.get(o) ?? none;
    }

    async create(object: RecordObject, input: ViewInput & { name: string }): Promise<SavedView> {
        const context = this.current();
        if (input.isShared) this.requireShare(context);
        const row = await this.rls.withWorkspace((tx) => this.createIn(tx, context, object, input));
        return view(row);
    }

    /**
     * The write inside a caller's transaction, checked against the object's fields like any view.
     * Whether the caller may share is the route's decision (`create`); the Twenty importer (P4-4)
     * makes a shared view per message list here, in the transaction that imports the list.
     */
    createIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        object: RecordObject,
        input: ViewInput & { name: string },
    ): Promise<ViewRow> {
        return this.check(tx, object, input).then(() =>
            tx.savedView.create({
                data: {
                    workspaceId: context.workspaceId,
                    object,
                    name: input.name,
                    icon: input.icon ?? null,
                    ownerMemberId: context.memberId ?? null,
                    isShared: input.isShared ?? false,
                    ...(input.filter ? { filter: input.filter as Prisma.InputJsonValue } : {}),
                    sorts: (input.sorts ?? []) as Prisma.InputJsonValue,
                    columns: (input.columns ?? []) as Prisma.InputJsonValue,
                    groupBy: input.groupBy ?? null,
                    ...(input.position !== undefined ? { position: input.position } : {}),
                },
            }),
        );
    }

    async update(id: string, patch: ViewInput): Promise<SavedView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            const current = await find(tx, context, id);
            this.requireEditable(context, current, patch);
            await this.check(tx, current.object, patch);
            return tx.savedView.update({
                where: { id },
                data: {
                    ...(patch.name !== undefined ? { name: patch.name } : {}),
                    ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
                    ...(patch.filter !== undefined
                        ? { filter: patch.filter === null ? Prisma.DbNull : (patch.filter as Prisma.InputJsonValue) }
                        : {}),
                    ...(patch.sorts !== undefined ? { sorts: patch.sorts as Prisma.InputJsonValue } : {}),
                    ...(patch.columns !== undefined ? { columns: patch.columns as Prisma.InputJsonValue } : {}),
                    ...(patch.groupBy !== undefined ? { groupBy: patch.groupBy } : {}),
                    ...(patch.position !== undefined ? { position: patch.position } : {}),
                    ...(patch.isShared !== undefined ? { isShared: patch.isShared } : {}),
                },
            });
        });
        return view(row);
    }

    async remove(id: string): Promise<void> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const current = await find(tx, context, id);
            this.requireEditable(context, current, {});
            await tx.savedView.delete({ where: { id } });
        });
    }

    /** A private copy of any view the caller can see, named "<name> (copy)", owned by them. */
    async duplicate(id: string): Promise<SavedView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            const source = await find(tx, context, id);
            return tx.savedView.create({
                data: {
                    workspaceId: context.workspaceId,
                    object: source.object,
                    name: `${source.name} (copy)`,
                    icon: source.icon,
                    ownerMemberId: context.memberId ?? null,
                    isShared: false,
                    filter: source.filter === null ? Prisma.DbNull : (source.filter as Prisma.InputJsonValue),
                    sorts: source.sorts as Prisma.InputJsonValue,
                    columns: source.columns as Prisma.InputJsonValue,
                    groupBy: source.groupBy,
                },
            });
        });
        return view(row);
    }

    /**
     * Own views need `view:save` (the route's gate); a shared view — editing it, deleting it,
     * or making one shared — needs `view:share` too. `403`: the caller can see the view, so the
     * refusal leaks nothing.
     */
    private requireEditable(context: WorkspaceRunContext, current: ViewRow, patch: ViewInput): void {
        const own = context.memberId !== undefined && current.ownerMemberId === context.memberId;
        if (current.isShared || patch.isShared) this.requireShare(context);
        else if (!own) throw new ForbiddenException('only the view’s author may change it');
    }

    private requireShare(context: WorkspaceRunContext): void {
        if (!context.capabilities.has('view:share')) {
            throw new ForbiddenException('sharing a view, or changing a shared one, needs view:share');
        }
    }

    /** The filter, sorts, columns and grouping all name fields the object has; the same checks the list runs. */
    private async check(tx: WorkspaceClient, object: RecordObject, input: ViewInput): Promise<void> {
        const fields = resolveFields(object, await this.customFields.visibleDefinitions(tx, object));
        if (input.filter) compileFilter(input.filter, fields);
        for (const s of input.sorts ?? []) checkSortable(fields, s.field);
        for (const c of input.columns ?? []) fieldNamed(fields, c.field, 'columns');
        if (input.groupBy) {
            const field = fieldNamed(fields, input.groupBy, 'groupBy');
            if (!field.groupable) throw new BadRequestException(`groupBy: ${input.groupBy} cannot be grouped by`);
        }
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('ViewsService is used inside a workspace scope');
        return context;
    }
}

async function find(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<ViewRow> {
    const row = await tx.savedView.findFirst({ where: { id, ...visibleViews(context) } });
    if (!row) throw new NotFoundException('view not found');
    return row;
}

function view(row: ViewRow): SavedView {
    return {
        id: row.id,
        object: row.object,
        name: row.name,
        icon: row.icon,
        ownerMemberId: row.ownerMemberId,
        isShared: row.isShared,
        filter: row.filter === null ? null : stored<FilterGroup>(row.filter),
        sorts: stored<ViewSort[]>(row.sorts),
        columns: stored<ViewColumn[]>(row.columns),
        groupBy: row.groupBy,
        position: row.position,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}
