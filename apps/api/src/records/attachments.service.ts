import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Actor, RecordTarget } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { FILE_STORAGE, FileNotInStorage, type FileStorage } from '../infra/storage/file-storage';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from './actor';
import { stored } from './references';
import { anyTargetReadable, assertTargetsReadable } from './targets';
import { type AttachmentView } from './responses';
export type { AttachmentView } from './responses';

export interface UploadInput {
    target: RecordTarget;
    name: string;
    mime: string;
    body: Readable;
}

type AttachmentRow = Prisma.AttachmentGetPayload<Record<string, never>>;

/**
 * Attachments sit on exactly one record and are visible to whoever can see it. The bytes are
 * written to storage first and the row second; if the row cannot be written the bytes are
 * removed again, so storage never holds a file no row can reach. Deleting is soft and keeps the
 * bytes — restore is a row change — until a retention job (not v1) empties the trash.
 */
@Injectable()
export class AttachmentsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
        @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    ) {}

    list(target: RecordTarget, deleted = false): Promise<AttachmentView[]> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            if (!(await anyTargetReadable(tx, [target]))) throw new NotFoundException('target not found');
            const rows = await tx.attachment.findMany({
                where: { targetType: target.type, targetId: target.id, deletedAt: deleted ? { not: null } : null },
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            });
            return rows.map(view);
        });
    }

    get(id: string): Promise<AttachmentView> {
        this.current();
        return this.rls.withWorkspace(async (tx) => view(await find(tx, id, false)));
    }

    /** The bytes, with the metadata the response headers need. */
    content(id: string): Promise<{ attachment: AttachmentView; body: Readable }> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const row = await find(tx, id, false);
            try {
                return { attachment: view(row), body: await this.storage.get(row.storageKey) };
            } catch (error) {
                // The row exists and the bytes do not: storage lost them. Say so; do not pretend the row is gone.
                if (error instanceof FileNotInStorage) throw new NotFoundException('attachment content is missing');
                throw error;
            }
        });
    }

    async upload(input: UploadInput): Promise<AttachmentView> {
        const context = this.current();
        const actor = actorOf(context);
        // The target is checked before a byte is stored, so a refused upload stores nothing.
        await this.rls.withWorkspace((tx) => assertTargetsReadable(tx, [input.target]));
        const storageKey = `${context.workspaceId}/${randomUUID()}`;
        const { bytes } = await this.storage.put(storageKey, input.body);
        let row: AttachmentRow;
        try {
            row = await this.rls.withWorkspace((tx) =>
                tx.attachment.create({
                    data: {
                        workspaceId: context.workspaceId,
                        name: input.name,
                        storageKey,
                        mime: input.mime,
                        sizeBytes: BigInt(bytes),
                        targetType: input.target.type,
                        targetId: input.target.id,
                        authorId: context.memberId ?? null,
                        createdBy: actor,
                    },
                }),
            );
        } catch (error) {
            await this.storage.delete(storageKey);
            throw error;
        }
        this.events.publish({
            type: 'attachment.created',
            object: 'attachment',
            workspaceId: context.workspaceId,
            actor,
            occurredAt: new Date().toISOString(),
            recordId: row.id,
            targets: [input.target],
        });
        return view(row);
    }

    async remove(id: string): Promise<void> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            const current = await find(tx, id, false);
            await tx.attachment.update({ where: { id }, data: { deletedAt: new Date() } });
            return current;
        });
        this.events.publish({
            type: 'attachment.deleted',
            object: 'attachment',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
            targets: [targetOf(row)],
        });
    }

    async restore(id: string): Promise<AttachmentView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            await find(tx, id, true);
            return tx.attachment.update({ where: { id }, data: { deletedAt: null } });
        });
        this.events.publish({
            type: 'attachment.restored',
            object: 'attachment',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: id,
            targets: [targetOf(row)],
        });
        return view(row);
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('AttachmentsService is used inside a workspace scope');
        return context;
    }
}

/** An attachment on a record the caller can see, or `404`. */
async function find(tx: WorkspaceClient, id: string, deleted: boolean): Promise<AttachmentRow> {
    const row = await tx.attachment.findFirst({ where: { id, deletedAt: deleted ? { not: null } : null } });
    if (!row || !(await anyTargetReadable(tx, [targetOf(row)]))) throw new NotFoundException('attachment not found');
    return row;
}

function targetOf(row: AttachmentRow): RecordTarget {
    return { type: row.targetType, id: row.targetId };
}

export function view(row: AttachmentRow): AttachmentView {
    return {
        id: row.id,
        name: row.name,
        mime: row.mime,
        sizeBytes: Number(row.sizeBytes),
        target: targetOf(row),
        authorId: row.authorId,
        createdBy: stored<Actor>(row.createdBy),
        deletedAt: row.deletedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
