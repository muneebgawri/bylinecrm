import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { CustomFieldType, RecordObject } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { UniqueConflict } from '../../infra/errors/api-errors';
import { uniqueViolation } from '../../infra/prisma-errors';
import { RedisService } from '../../infra/redis.service';
import { RlsPrismaService, type WorkspaceClient } from '../../infra/rls-prisma.service';
import { WorkspaceContext } from '../../infra/workspace-context';
import {
    type FieldDefinition,
    mergeCustomValues,
    optionsProblem,
    validateCustomValues,
    type ValidationMode,
} from './custom-values';
import { type CustomFieldView } from '../responses';
export type { CustomFieldView } from '../responses';

export interface CreateCustomFieldInput {
    object: RecordObject;
    key: string;
    label: string;
    type: CustomFieldType;
    options?: string[] | undefined;
    required?: boolean | undefined;
    position?: number | undefined;
}

export interface UpdateCustomFieldInput {
    label?: string | undefined;
    options?: string[] | undefined;
    required?: boolean | undefined;
    position?: number | undefined;
}

/** How long a workspace's definitions stay cached when nothing changes them. */
const DEFINITIONS_TTL_S = 3600;

/**
 * Definitions of the fields a workspace added to its objects, and the validation of the values
 * records carry under them. The active definitions of one `(workspace, object)` are cached in
 * Redis and the entry is deleted on every write, so a change applies on the next request; with
 * Redis down the rows are read directly and nothing else changes.
 */
@Injectable()
export class CustomFieldsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly redis: RedisService,
        private readonly context: WorkspaceContext,
    ) {}

    list(filter: { object?: RecordObject | undefined; archived?: boolean | undefined }): Promise<CustomFieldView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.customFieldDefinition.findMany({
                where: {
                    ...(filter.object ? { object: filter.object } : {}),
                    archivedAt: filter.archived ? { not: null } : null,
                },
                orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            });
            return rows.map(view);
        });
    }

    async create(input: CreateCustomFieldInput): Promise<CustomFieldView> {
        const options = input.options ?? [];
        const problem = optionsProblem(input.type, options);
        if (problem) throw new UnprocessableEntityException(problem);
        const workspaceId = this.workspaceId();
        const row = await this.rls.withWorkspace(async (tx) => {
            try {
                return await tx.customFieldDefinition.create({
                    data: {
                        workspaceId,
                        object: input.object,
                        key: input.key,
                        label: input.label,
                        type: input.type,
                        options,
                        required: input.required ?? false,
                        ...(input.position !== undefined ? { position: input.position } : {}),
                    },
                });
            } catch (error) {
                throw uniqueViolation(error)
                    ? new UniqueConflict(`a ${input.object} field with key "${input.key}" exists`, 'key')
                    : error;
            }
        });
        await this.invalidate(workspaceId, input.object);
        return view(row);
    }

    /** Label, options, required and position may change; the type is fixed once values may exist. */
    async update(id: string, patch: UpdateCustomFieldInput): Promise<CustomFieldView> {
        const workspaceId = this.workspaceId();
        const row = await this.rls.withWorkspace(async (tx) => {
            const current = await tx.customFieldDefinition.findUnique({ where: { id } });
            if (!current) throw new NotFoundException('custom field not found');
            if (patch.options !== undefined) {
                const problem = optionsProblem(current.type, patch.options);
                if (problem) throw new UnprocessableEntityException(problem);
            }
            return tx.customFieldDefinition.update({
                where: { id },
                data: {
                    ...(patch.label !== undefined ? { label: patch.label } : {}),
                    ...(patch.options !== undefined ? { options: patch.options } : {}),
                    ...(patch.required !== undefined ? { required: patch.required } : {}),
                    ...(patch.position !== undefined ? { position: patch.position } : {}),
                },
            });
        });
        await this.invalidate(workspaceId, row.object);
        return view(row);
    }

    /**
     * A definition is archived, never deleted: records may hold its value. From now on the key is
     * unknown to the validator; stored values are left alone.
     */
    async archive(id: string): Promise<void> {
        const workspaceId = this.workspaceId();
        const row = await this.rls.withWorkspace(async (tx) => {
            const current = await tx.customFieldDefinition.findUnique({ where: { id } });
            if (!current) throw new NotFoundException('custom field not found');
            if (current.archivedAt) return current;
            return tx.customFieldDefinition.update({ where: { id }, data: { archivedAt: new Date() } });
        });
        await this.invalidate(workspaceId, row.object);
    }

    /**
     * Validates a record's `custom` values against the object's active definitions, inside the
     * caller's transaction. On `patch` the result is merged over `stored`. The result is JSON by
     * construction — every value type the schema admits is a JSON scalar or an array of them —
     * which is what the column takes.
     */
    async validated(
        tx: WorkspaceClient,
        object: RecordObject,
        values: Record<string, unknown>,
        mode: ValidationMode,
        stored: Record<string, unknown> = {},
    ): Promise<Prisma.InputJsonObject> {
        const definitions = await this.activeDefinitions(tx, object);
        const valid = validateCustomValues(definitions, values, mode);
        return (mode === 'patch' ? mergeCustomValues(stored, valid) : valid) as Prisma.InputJsonObject;
    }

    /**
     * The active definitions of one object: from the cache when it has them, else from the rows.
     * Public because the query machinery (P1-4) resolves `custom.<key>` fields against the same list
     * the validator uses — one source of what a workspace's custom fields are.
     */
    async activeDefinitions(tx: WorkspaceClient, object: RecordObject): Promise<FieldDefinition[]> {
        const key = cacheKey(this.workspaceId(), object);
        try {
            const cached = await this.redis.get(key);
            if (cached) return JSON.parse(cached) as FieldDefinition[];
        } catch {
            // Redis unavailable: the rows are the truth anyway; the cache is only a shortcut to them.
        }
        const rows = await tx.customFieldDefinition.findMany({
            where: { object, archivedAt: null },
            select: { key: true, label: true, type: true, options: true, required: true },
        });
        const definitions = rows.map((r) => ({ ...r, options: r.options as string[] }));
        try {
            await this.redis.set(key, JSON.stringify(definitions), 'EX', DEFINITIONS_TTL_S);
        } catch {
            // Same: a cache that cannot be written costs a database read next time, nothing more.
        }
        return definitions;
    }

    private async invalidate(workspaceId: string, object: RecordObject): Promise<void> {
        try {
            await this.redis.del(cacheKey(workspaceId, object));
        } catch {
            // Redis unavailable: there is no stale entry to delete, the next read goes to the rows.
        }
    }

    private workspaceId(): string {
        const current = this.context.get();
        if (!current) throw new Error('custom fields are read inside a workspace scope');
        return current.workspaceId;
    }
}

function cacheKey(workspaceId: string, object: RecordObject): string {
    // `v2`: the cached shape gained `label` in P1-4; an older entry would lack it.
    return `custom-fields:v2:${workspaceId}:${object}`;
}

function view(row: {
    id: string;
    object: RecordObject;
    key: string;
    label: string;
    type: CustomFieldType;
    options: unknown;
    required: boolean;
    position: number;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}): CustomFieldView {
    return {
        id: row.id,
        object: row.object,
        key: row.key,
        label: row.label,
        type: row.type,
        options: row.options as string[],
        required: row.required,
        position: row.position,
        archivedAt: row.archivedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
