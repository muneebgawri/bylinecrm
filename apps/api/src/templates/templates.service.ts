import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
    CUSTOM_VARIABLE_SOURCES,
    TEMPLATE_NAME_MAX,
    SIGNATURE_PLACEMENT_VARIABLE,
    TEMPLATE_VARIABLES,
    type Actor,
    type CustomVariableSource,
    type DomainEvent,
    type DomainEventType,
    type FieldChange,
    type EmailTemplateBody,
    type RecordObject,
    type RichText,
    type TemplateKind,
} from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException, ValidationFailed } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from '../records/actor';
import { CustomFieldsService } from '../records/custom-fields/custom-fields.service';
import { diffOf, isEmpty } from '../records/diff';
import { type Page, paginate } from '../records/list-query';
import { bodyProblems, subjectVariablePaths, variablePathsOf } from './render/body-subset';
import type { ComposedEmail } from './render/compose';
import { unknownVariables, type CustomKeys } from './render/variables';
import { signableMailbox } from '../signatures/signature-store';
import { RenderService } from './render.service';
import type { EmailTemplateView, TemplateVariablesView } from './responses';

export interface TemplateInput {
    name: string;
    kind: TemplateKind;
    subject: string;
    body: RichText;
}

/** A partial update: each field, or nothing. */
export type TemplatePatch = { [K in keyof TemplateInput]?: TemplateInput[K] | undefined };

export interface ListTemplatesQuery {
    kind?: TemplateKind | undefined;
    q?: string | undefined;
    cursor?: string | undefined;
    limit: number;
}

/** The fields a template's `updated` event reports. */
const DIFF_FIELDS = ['name', 'kind', 'subject', 'body'] as const;
/** Where a custom variable's definitions live: `deal` is the opportunity object. */
const SOURCE_OBJECT: Record<CustomVariableSource, RecordObject> = {
    person: 'person',
    company: 'company',
    deal: 'opportunity',
};
const COPY_SUFFIX = ' (copy)';

type TemplateRow = Prisma.EmailTemplateGetPayload<object>;

/**
 * Email templates (P2-4; FR-CRMS-3). Workspace-wide: every member who may read templates reads
 * all of them. Two rules sit on the data rather than the route, because the route cannot see
 * them: a template that is — or would become — `outreach` needs `outreach:write` as well as the
 * route's `template:write`; and a PATCH must name the version it edited, so a concurrent edit is a
 * `409`, never a silent overwrite.
 */
@Injectable()
export class TemplatesService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
        private readonly customFields: CustomFieldsService,
        private readonly renderer: RenderService,
    ) {}

    list(query: ListTemplatesQuery, deleted = false): Promise<Page<EmailTemplateView>> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.emailTemplate.findMany({
                    where: {
                        deletedAt: deleted ? { not: null } : null,
                        ...(query.kind ? { kind: query.kind } : {}),
                        ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
                    },
                    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
                    ...args,
                }),
            );
            return { items: page.items.map(view), nextCursor: page.nextCursor };
        });
    }

    get(id: string): Promise<EmailTemplateView> {
        this.current();
        return this.rls.withWorkspace(async (tx) => view(await find(tx, id, false)));
    }

    /** The registry and the workspace's custom fields as variables — what the editor offers. */
    variables(): Promise<TemplateVariablesView> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const custom: TemplateVariablesView['custom'] = [];
            for (const source of CUSTOM_VARIABLE_SOURCES) {
                for (const definition of await this.customFields.activeDefinitions(tx, SOURCE_OBJECT[source])) {
                    custom.push({
                        path: `${source}.custom.${definition.key}`,
                        source,
                        label: definition.label,
                        type: definition.type,
                        optional: false,
                    });
                }
            }
            return {
                standard: TEMPLATE_VARIABLES.map((v) => ({
                    path: v.path,
                    source: v.source,
                    label: v.label,
                    type: v.type,
                    optional: 'optional' in v,
                })),
                custom,
            };
        });
    }

    async create(input: TemplateInput): Promise<EmailTemplateView> {
        const context = this.current();
        const row = await this.rls.withWorkspace((tx) => this.createIn(tx, context, input));
        return view(row);
    }

    /**
     * The write inside a caller's transaction, validated and announced like any create. The routes
     * above and the Twenty importer (P4-4, a campaign becomes an outreach template) both run it.
     */
    async createIn(tx: WorkspaceClient, context: WorkspaceRunContext, input: TemplateInput): Promise<TemplateRow> {
        assertMayWriteKind(context, input.kind);
        const actor = actorOf(context);
        await this.assertValid(tx, input);
        const created = await tx.emailTemplate.create({
            data: {
                workspaceId: context.workspaceId,
                name: input.name,
                kind: input.kind,
                subject: input.subject,
                body: input.body as Prisma.InputJsonObject,
                createdBy: actor as Prisma.InputJsonObject,
                updatedBy: actor as Prisma.InputJsonObject,
            },
        });
        await this.record(tx, 'template.created', created.id, actor);
        return created;
    }

    /**
     * A partial update of the version the caller edited. Nothing that would change is nothing
     * written: the version stays, `updatedAt` stays, and no event is recorded (P1-4a's rule).
     */
    async update(id: string, patch: TemplatePatch, editedVersion: number): Promise<EmailTemplateView> {
        const context = this.current();
        const result = await this.rls.withWorkspace((tx) => this.updateIn(tx, context, id, patch, editedVersion));
        return view(result.row);
    }

    /**
     * The update inside a caller's transaction. `editedVersion` is the version the caller edited —
     * or `null` for a caller that owns the content whatever its version (the Twenty importer
     * re-reading a campaign), which still never overwrites an edit made while it ran.
     */
    async updateIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        id: string,
        patch: TemplatePatch,
        editedVersion: number | null,
    ): Promise<{ row: TemplateRow; diff: Record<string, FieldChange> }> {
        const actor = actorOf(context);
        const current = await find(tx, id, false);
        assertMayWriteKind(context, current.kind);
        if (patch.kind) assertMayWriteKind(context, patch.kind);
        const edited = editedVersion ?? current.version;
        if (current.version !== edited) throw versionConflict(edited, current.version);
        const next: EmailTemplateBody = {
            name: patch.name ?? current.name,
            kind: patch.kind ?? current.kind,
            subject: patch.subject ?? current.subject,
            body: patch.body ?? (current.body as unknown as RichText),
        };
        const diff = diffOf(view(current), { ...view(current), ...next }, DIFF_FIELDS);
        if (isEmpty(diff)) return { row: current, diff };
        if (patch.subject !== undefined || patch.body !== undefined) await this.assertValid(tx, next);
        // The version guard makes the write conditional on nobody having written in between.
        const written = await tx.emailTemplate.updateMany({
            where: { id, version: current.version, deletedAt: null },
            data: {
                name: next.name,
                kind: next.kind,
                subject: next.subject,
                body: next.body as Prisma.InputJsonObject,
                version: { increment: 1 },
                updatedBy: actor as Prisma.InputJsonObject,
            },
        });
        if (written.count === 0) {
            const now = await find(tx, id, false);
            throw versionConflict(edited, now.version);
        }
        await this.record(tx, 'template.updated', id, actor, diff);
        return { row: await find(tx, id, false), diff };
    }

    async remove(id: string): Promise<void> {
        const context = this.current();
        const actor = actorOf(context);
        await this.rls.withWorkspace(async (tx) => {
            const current = await find(tx, id, false);
            assertMayWriteKind(context, current.kind);
            await tx.emailTemplate.update({
                where: { id },
                data: { deletedAt: new Date(), updatedBy: actor as Prisma.InputJsonObject },
            });
            await this.record(tx, 'template.deleted', id, actor);
        });
    }

    async restore(id: string): Promise<EmailTemplateView> {
        const context = this.current();
        const actor = actorOf(context);
        const row = await this.rls.withWorkspace(async (tx) => {
            const current = await find(tx, id, true);
            assertMayWriteKind(context, current.kind);
            const restored = await tx.emailTemplate.update({
                where: { id },
                data: { deletedAt: null, updatedBy: actor as Prisma.InputJsonObject },
            });
            await this.record(tx, 'template.restored', id, actor);
            return restored;
        });
        return view(row);
    }

    /** A new template with the same content, named "<name> (copy)", at version 1. */
    async duplicate(id: string): Promise<EmailTemplateView> {
        this.current();
        const source = await this.rls.withWorkspace(async (tx) => find(tx, id, false));
        return this.create({
            name: `${source.name.slice(0, TEMPLATE_NAME_MAX - COPY_SUFFIX.length)}${COPY_SUFFIX}`,
            kind: source.kind,
            subject: source.subject,
            body: source.body as unknown as RichText,
        });
    }

    /** The template rendered for one recipient (and deal), as the caller would send it. */
    /**
     * The template rendered for a person, with the signature that would follow it (#193): `mailboxId`'s,
     * when one is named (one the caller may sign), else the workspace default.
     */
    async preview(
        id: string,
        target: { personId: string; dealId?: string | undefined; mailboxId?: string | undefined },
    ): Promise<ComposedEmail> {
        const context = this.current();
        const template = await this.get(id);
        const { mailboxId, ...rest } = target;
        const mailbox = mailboxId
            ? await this.rls.withWorkspace((tx) => signableMailbox(tx, context, mailboxId))
            : null;
        return this.renderer.render(template, {
            ...rest,
            senderMemberId: mailbox?.ownerMemberId ?? context.memberId,
            signature: mailbox ? { from: 'mailbox', mailboxId: mailbox.id } : { from: 'default' },
        });
    }

    /**
     * A subject and body that are not a stored template — the send path's free-form message (P2-3) —
     * checked by the same rule a template is: inside the subset, naming only variables that exist.
     */
    validateDraft(draft: Pick<TemplateInput, 'subject' | 'body'>): Promise<void> {
        return this.rls.withWorkspace((tx) => this.assertValid(tx, draft));
    }

    /** A template's subject and body: inside the subset, naming only variables that exist. */
    private async assertValid(tx: WorkspaceClient, template: Pick<TemplateInput, 'subject' | 'body'>): Promise<void> {
        const custom = {} as Record<CustomVariableSource, Set<string>>;
        for (const source of CUSTOM_VARIABLE_SOURCES) {
            const definitions = await this.customFields.activeDefinitions(tx, SOURCE_OBJECT[source]);
            custom[source] = new Set(definitions.map((d) => d.key));
        }
        const problems = [
            ...bodyProblems(template.body),
            ...unknownVariables(
                [
                    ...subjectVariablePaths(template.subject).map((path) => ({ path, at: 'subject' })),
                    ...variablePathsOf(template.body),
                ],
                custom as CustomKeys,
            ),
            // A signature is placed in the body (#193); a subject line cannot carry one.
            ...(subjectVariablePaths(template.subject).includes(SIGNATURE_PLACEMENT_VARIABLE)
                ? [{ path: 'subject', message: '{{sender.signature}} goes in the body, not the subject' }]
                : []),
        ];
        if (problems.length > 0) throw new ValidationFailed('the template is not valid', problems);
    }

    /** Records a template event in the transaction that made the change (P1-6). */
    private record(
        tx: WorkspaceClient,
        type: DomainEventType & `template.${string}`,
        recordId: string,
        actor: Actor,
        diff?: Record<string, FieldChange>,
    ): Promise<void> {
        const context = this.current();
        return this.events.record(tx, {
            type,
            object: 'template',
            workspaceId: context.workspaceId,
            actor,
            occurredAt: new Date().toISOString(),
            recordId,
            ...(diff ? { diff } : {}),
        } as DomainEvent);
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('TemplatesService is used inside a workspace scope');
        return context;
    }
}

/** An outreach template is mail a sequence sends to people who did not ask for it: writing one needs `outreach:write`. */
function assertMayWriteKind(context: WorkspaceRunContext, kind: TemplateKind): void {
    if (kind === 'outreach' && !context.capabilities.has('outreach:write')) {
        throw new ForbiddenException('outreach templates need the outreach:write capability');
    }
}

function versionConflict(edited: number, now: number): ApiException {
    return new ApiException(409, 'conflict', `the template changed since version ${edited}; it is now version ${now}`);
}

/** A template in one state (live, or in the trash when `deleted`), or `404`. */
async function find(tx: WorkspaceClient, id: string, deleted: boolean): Promise<TemplateRow> {
    const row = await tx.emailTemplate.findFirst({ where: { id, deletedAt: deleted ? { not: null } : null } });
    if (!row) throw new NotFoundException('template not found');
    return row;
}

export function view(row: TemplateRow): EmailTemplateView {
    return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        subject: row.subject,
        body: row.body as unknown as RichText,
        version: row.version,
        createdBy: row.createdBy as unknown as Actor,
        updatedBy: row.updatedBy as unknown as Actor,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
    };
}
