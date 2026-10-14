import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import {
    TWENTY_IMPORT_ERRORS_KEPT,
    TWENTY_IMPORT_ERROR_MESSAGE_MAX,
    type TwentyImportMode,
    TWENTY_IMPORT_OBJECTS,
    TWENTY_IMPORT_SOURCE,
    TWENTY_LIST_VIEW_PREFIX,
    TWENTY_LISTS_FIELD_KEY,
    emptyObjectReport,
    type Capability,
    type DomainEvent,
    type RecordObject,
    type StageKind,
    type TwentyImportObject,
    type TwentyImportObjectReport,
} from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException } from '../infra/errors/api-errors';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { stageData } from '../pipelines/pipelines.service';
import { StageMoveService } from '../pipelines/stage-move.service';
import { actorOf } from '../records/actor';
import { CompaniesService } from '../records/companies.service';
import { CustomFieldsService } from '../records/custom-fields/custom-fields.service';
import type { FieldDefinition } from '../records/custom-fields/custom-values';
import { NotesService } from '../records/notes.service';
import { OpportunitiesService } from '../records/opportunities.service';
import { PeopleService, type PersonInput } from '../records/people.service';
import { defaultCurrency, stored } from '../records/references';
import { TasksService } from '../records/tasks.service';
import { ExclusionsService } from '../sequences/exclusions.service';
import { TemplatesService } from '../templates/templates.service';
import { ViewsService } from '../views/views.service';
import { customValuesFor, definitionsNeeded, type InferredCustom } from './custom-fields-sync';
import {
    countLinks,
    loadLinks,
    writeLink,
    type LinkIndex,
    type LinkRef,
    type LocalType,
    flagLinksUnseen,
    markLinksSeen,
} from './links';
import {
    isSkip,
    mapCompany,
    mapLeadLookup,
    mapLeadView,
    mapMessageCampaign,
    mapMessageList,
    mapMessageListMember,
    mapNote,
    mapOpportunity,
    mapPerson,
    mapTask,
    memberEmailOf,
    type MappedLeadView,
    type MappedOpportunity,
} from './mappers';
import { fieldsEditedAfter } from '../timeline/timeline.service';
import { TWENTY_RELEASE_NOTE } from './twenty-import.constants';
import { readConnection } from './twenty-import.settings';
import { withoutLocalEdits } from './twenty-sync';
import { TwentySyncService } from './twenty-sync.service';
import { isObject, text } from './twenty-records';
import { databaseUnavailable } from '../infra/prisma-errors';
import { TwentyApiError } from './twenty.http';
import { TWENTY_PORT, type TwentyApi, type TwentyConnection, type TwentyPage, type TwentyRecord } from './twenty.port';

/** What the runner may do in a workspace: write outreach templates and shared views for what it imports. */
const JOB_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
    'outreach:write',
    'template:write',
    'view:share',
]);

/** Notes and tasks come with their targets (`depth=1`); everything else is read bare. */
const DEPTH: Readonly<Record<TwentyImportObject, 0 | 1>> = {
    workspaceMembers: 0,
    companies: 0,
    people: 0,
    opportunities: 0,
    notes: 1,
    tasks: 1,
    leadLookups: 0,
    leadViews: 0,
    messageLists: 0,
    messageListMembers: 0,
    messageCampaigns: 0,
};

/** Which record object a Twenty object's extra fields land on, when it has one. */
const CUSTOM_OBJECT: Readonly<Partial<Record<TwentyImportObject, RecordObject>>> = {
    companies: 'company',
    people: 'person',
    opportunities: 'opportunity',
    leadViews: 'person',
};

type Outcome = 'created' | 'updated' | 'unchanged' | 'merged' | 'skipped';
type Cursors = Record<string, string | null>;

/** A Twenty record's relations: the links a page must have in hand before it is mapped. */
function referencesOf(object: TwentyImportObject, record: TwentyRecord): LinkRef[] {
    const refs: LinkRef[] = [{ object, externalId: record.id }];
    const add = (target: TwentyImportObject, value: unknown) => {
        if (typeof value === 'string' && value) refs.push({ object: target, externalId: value });
    };
    const addTargets = (value: unknown) => {
        for (const raw of Array.isArray(value) ? value : []) {
            if (!isObject(raw)) continue;
            add('people', raw.targetPersonId);
            add('companies', raw.targetCompanyId);
            add('opportunities', raw.targetOpportunityId);
        }
    };
    switch (object) {
        case 'companies':
            add('workspaceMembers', record.accountOwnerId);
            break;
        case 'people':
            add('companies', record.companyId);
            add('workspaceMembers', record.personOwnerId);
            break;
        case 'opportunities':
            add('companies', record.companyId);
            add('people', record.pointOfContactId);
            add('workspaceMembers', record.ownerId);
            break;
        case 'notes':
            addTargets(record.noteTargets);
            if (isObject(record.createdBy)) add('workspaceMembers', record.createdBy.workspaceMemberId);
            break;
        case 'tasks':
            addTargets(record.taskTargets);
            add('workspaceMembers', record.assigneeId);
            break;
        case 'leadViews':
            add('people', record.personId);
            add('workspaceMembers', record.assignedAmMemberId);
            break;
        case 'messageListMembers':
            add('people', record.personId);
            add('messageLists', record.listId);
            break;
        default:
            break;
    }
    return refs;
}

/**
 * Drives one import run (P4-4, doc 48 §11). The run row is the truth: where it is (`phase`, a
 * cursor per object) and what it did (`report`), written in the same transaction as each page's
 * records, so a run that dies resumes from the page after the last one committed and never
 * counts a record twice. Every object is read page by page from Twenty — outside any transaction
 * — and each page is written through the services the routes use (people, companies, deals,
 * notes, tasks, exclusions, views, templates), as the import (`actor: { kind: 'import' }`), so an
 * imported record is validated, placed in its pipeline and announced through the outbox like any
 * other. A record maps by its Twenty id (`twenty_import_links`); one already mapped is updated
 * where it differs and otherwise left alone; one that matches an existing record by its unique
 * key (a person's address, a company's domain) is merged into it. A record the mapper cannot
 * place, or the services refuse, is counted and named in the report, and the run goes on.
 */
@Injectable()
export class TwentyImportRunner {
    private readonly logger = new Logger(TwentyImportRunner.name);

    constructor(
        private readonly ownerPrisma: PrismaService,
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        @Inject(TWENTY_PORT) private readonly twenty: TwentyApi,
        private readonly events: DomainEvents,
        private readonly customFields: CustomFieldsService,
        private readonly people: PeopleService,
        private readonly companies: CompaniesService,
        private readonly opportunities: OpportunitiesService,
        private readonly notes: NotesService,
        private readonly tasks: TasksService,
        private readonly moves: StageMoveService,
        private readonly exclusions: ExclusionsService,
        private readonly views: ViewsService,
        private readonly templates: TemplatesService,
        private readonly sync: TwentySyncService,
        private readonly auth: AuthService,
    ) {}

    /** Runs `runId` to its end — succeeded, failed, cancelled — or throws so the queue retries it from its cursor. */
    async run(runId: string): Promise<void> {
        const head = await this.ownerPrisma.twentyImportRun.findUnique({
            where: { id: runId },
            select: { workspaceId: true, status: true },
        });
        if (!head || (head.status !== 'queued' && head.status !== 'running')) return;
        await this.context.run(
            { workspaceId: head.workspaceId, capabilities: JOB_CAPABILITIES, actor: { kind: 'import', id: runId } },
            () => this.execute(runId),
        );
    }

    /** The queue gave up on the run's job: it is failed, with the last error, unless it finished meanwhile. */
    async abandon(runId: string, error: string): Promise<void> {
        const head = await this.ownerPrisma.twentyImportRun.findUnique({
            where: { id: runId },
            select: { workspaceId: true },
        });
        if (!head) return;
        await this.rls.withWorkspace(head.workspaceId, async (tx) => {
            const { count } = await tx.twentyImportRun.updateMany({
                where: { id: runId, status: { in: ['queued', 'running'] } },
                data: { status: 'failed', error, finishedAt: new Date(), phase: null },
            });
            if (count === 0) return;
            await this.sync.recordOutcome(tx, await tx.twentyImportRun.findUniqueOrThrow({ where: { id: runId } }));
        });
    }

    private async execute(runId: string): Promise<void> {
        const context = this.context.get()!;
        const opened = await this.rls.withWorkspace(async (tx) => {
            const run = await tx.twentyImportRun.findUniqueOrThrow({ where: { id: runId } });
            return { run, stored: await readConnection(tx, this.secrets) };
        });
        if (opened.run.cancelRequested) return this.finish(runId, 'cancelled');
        if (!opened.stored) return this.finish(runId, 'failed', 'the Twenty connection was removed');
        const connection = opened.stored.connection;
        const cursors = stored<Cursors>(opened.run.cursor);
        const report = reportFrom(stored<TwentyImportObjectReport[]>(opened.run.report));
        const since = opened.run.since?.toISOString() ?? null;
        await this.rls.withWorkspace((tx) =>
            tx.twentyImportRun.update({
                where: { id: runId },
                data: { status: 'running', startedAt: opened.run.startedAt ?? new Date(), error: null },
            }),
        );
        const state: RunState = {
            runId,
            context,
            connection,
            cursors,
            report,
            since,
            stages: new Map(),
            mode: opened.run.mode,
            passStartedAt: opened.run.startedAt ?? new Date(),
            membersRoleId: opened.run.createMembersRoleId,
            accountsCreated: opened.run.accountsCreated,
            deactivated: new Map(),
        };
        try {
            // Members deactivated in Twenty are no longer listed, but records can still be theirs (#184):
            // read once per run (again on a resume), so an owner no page names can still be made.
            if (state.membersRoleId && state.mode !== 'reconcile') {
                state.deactivated = await this.readDeactivatedMembers(connection);
            }
            for (const object of TWENTY_IMPORT_OBJECTS) {
                if (cursors[object] === null) continue;
                const done = await this.readObject(state, object);
                if (!done) return this.finish(runId, 'cancelled', undefined, state);
            }
            await this.finish(runId, 'succeeded', undefined, state);
        } catch (error) {
            if (error instanceof TwentyApiError && error.permanent) {
                await this.finish(runId, 'failed', error.message, state);
                return;
            }
            // Something transient: keep the run where it is, say what happened, and let the queue retry it.
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`import run ${runId} interrupted on ${state.phase ?? '-'}: ${message}`);
            await this.rls.withWorkspace((tx) =>
                tx.twentyImportRun.update({ where: { id: runId }, data: { error: message } }),
            );
            throw error;
        }
    }

    /** Reads one object from where the run left it; `false` when a cancel was asked for on the way. */
    private async readObject(state: RunState, object: TwentyImportObject): Promise<boolean> {
        state.phase = object;
        const entry = reportEntry(state.report, object);
        let cursor = state.cursors[object] ?? null;
        if (state.cursors[object] === undefined) {
            entry.before = await this.rls.withWorkspace((tx) => countLinks(tx, object));
            cursor = null;
        }
        for (;;) {
            let page;
            try {
                page = await this.twenty.list(state.connection, object, {
                    cursor,
                    depth: DEPTH[object],
                    since: state.since,
                });
            } catch (error) {
                // An object this Twenty workspace does not have (no message lists, no campaigns): nothing to read.
                if (
                    error instanceof TwentyApiError &&
                    error.permanent &&
                    error.status !== 401 &&
                    error.status !== 403
                ) {
                    entry.remote = 0;
                    entry.after = entry.before;
                    recordError(entry, '-', error.message);
                    state.cursors[object] = null;
                    await this.saveProgress(state);
                    return true;
                }
                throw error;
            }
            if (entry.remote === null) entry.remote = page.totalCount;
            const next = page.hasNextPage && page.records.length > 0 ? page.endCursor : null;
            if (state.mode === 'reconcile') {
                await this.reconcilePage(state, object, page.records, entry, next === null ? null : next);
            } else {
                await this.writePage(state, object, page.records, entry, next === null ? null : next);
            }
            if (next === null) break;
            cursor = next;
            if (await this.cancelRequested(state.runId)) return false;
        }
        if (state.mode === 'reconcile') {
            // Every page of the object was read: what no page named is missing in source (#156).
            entry.missingInSource = await this.rls.withWorkspace((tx) =>
                flagLinksUnseen(tx, object, state.passStartedAt, new Date()),
            );
        }
        entry.after = await this.rls.withWorkspace((tx) => countLinks(tx, object));
        state.cursors[object] = null;
        await this.saveProgress(state);
        return true;
    }

    /**
     * A reconcile pass's page (#156): nothing is mapped or written — the links of the ids Twenty still
     * returns are marked seen, in one transaction with the run's progress, so a resumed pass loses
     * nothing and a record that came back is no longer flagged.
     */
    private async reconcilePage(
        state: RunState,
        object: TwentyImportObject,
        records: TwentyRecord[],
        entry: TwentyImportObjectReport,
        nextCursor: string | null,
    ): Promise<void> {
        const ids = records.map((record) => record.id);
        entry.read += ids.length;
        await this.rls.withWorkspace(async (tx) => {
            await markLinksSeen(tx, object, ids, new Date());
            state.cursors[object] = nextCursor === null ? '' : nextCursor;
            await tx.twentyImportRun.update({
                where: { id: state.runId },
                data: {
                    phase: object,
                    cursor: state.cursors,
                    report: state.report as unknown as Prisma.InputJsonValue,
                },
            });
        });
    }

    /**
     * One page: the links its records refer to are read, the records mapped, the custom-field
     * definitions they need put in place, then every record written — each under a savepoint, so
     * one the services refuse costs only itself — and the run's progress saved in the same
     * transaction as the writes.
     */
    private async writePage(
        state: RunState,
        object: TwentyImportObject,
        records: TwentyRecord[],
        entry: TwentyImportObjectReport,
        nextCursor: string | null,
    ): Promise<void> {
        const refs = records.flatMap((record) => referencesOf(object, record));
        if (state.membersRoleId) {
            // Accounts for Twenty members who are not here (#184), made through the account service —
            // outside the page's transaction (the users table is the owner's) and before it, so the
            // member pass links them and a record's owner resolves on this same run.
            if (object === 'workspaceMembers') await this.provisionMembers(state, records);
            await this.provisionDeactivatedOwners(state, refs);
        }
        const links = await this.rls.withWorkspace((tx) => loadLinks(tx, refs));
        const currency = await this.rls.withWorkspace((tx) => defaultCurrency(tx, state.context.workspaceId));
        // Mapping is pure, so anything it throws is this record's (#168): it is reported as failed,
        // with the reason, and the page goes on.
        const mapped = records.map((record) => {
            try {
                return { record, result: this.map(object, record, links, currency) };
            } catch (error) {
                return { record, result: { failed: failureText(error), custom: {} } };
            }
        });
        const definitions = await this.ensureDefinitions(
            object,
            mapped.map((m) => m.result.custom),
        );
        await this.rls.withWorkspace(async (tx) => {
            const events: DomainEvent[] = [];
            for (const { record, result } of mapped) {
                entry.read += 1;
                if ('failed' in result) {
                    entry.failed += 1;
                    recordError(entry, record.id, result.failed);
                    continue;
                }
                if (isSkip(result)) {
                    entry.skipped += 1;
                    recordError(entry, record.id, result.skip);
                    continue;
                }
                await tx.$executeRawUnsafe('SAVEPOINT import_record');
                try {
                    const kept: string[] = [];
                    const outcome = await this.write(
                        tx,
                        state,
                        object,
                        record,
                        result,
                        links,
                        definitions,
                        events,
                        kept,
                    );
                    await tx.$executeRawUnsafe('RELEASE SAVEPOINT import_record');
                    entry[outcome] += 1;
                    if (outcome === 'skipped' && result.note) recordError(entry, record.id, result.note);
                    if (kept.length > 0) recordKept(entry, record.id, kept);
                } catch (error) {
                    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT import_record');
                    // The database or Twenty failing is the run's to retry; anything else — a service's
                    // refusal, a value the client rejects, a mapping the write cannot use — is this
                    // record's (#168): reported as failed, with the reason, and the page goes on.
                    if (databaseUnavailable(error) || error instanceof TwentyApiError) throw error;
                    entry.failed += 1;
                    recordError(
                        entry,
                        record.id,
                        error instanceof HttpException ? refusalText(error) : failureText(error),
                    );
                }
            }
            await this.events.recordAll(tx, events);
            state.cursors[object] = nextCursor === null ? '' : nextCursor;
            await tx.twentyImportRun.update({
                where: { id: state.runId },
                data: {
                    phase: object,
                    cursor: state.cursors,
                    report: state.report as unknown as Prisma.InputJsonValue,
                    accountsCreated: state.accountsCreated,
                },
            });
        });
    }

    private map(object: TwentyImportObject, record: TwentyRecord, links: LinkIndex, currency: string): MapResult {
        switch (object) {
            case 'workspaceMembers':
                return { custom: {}, input: null };
            case 'companies':
                return withCustom(mapCompany(record, links));
            case 'people':
                return withCustom(mapPerson(record, links));
            case 'opportunities': {
                // The deal's stage and lost reason ride beside the input: the write places and closes it.
                const deal = mapOpportunity(record, links, currency);
                return isSkip(deal) ? { skip: deal.skip, custom: {} } : { custom: deal.custom, input: deal };
            }
            case 'notes':
                return withCustom(mapNote(record, links));
            case 'tasks':
                return withCustom(mapTask(record, links));
            case 'leadLookups': {
                const lookup = mapLeadLookup(record);
                return 'skip' in lookup ? { skip: lookup.skip, custom: {} } : { custom: {}, input: lookup };
            }
            case 'leadViews': {
                // The person Twenty names and the lead's address ride beside the input: the write finds who it is.
                const lead = mapLeadView(record, links);
                return isSkip(lead) ? { skip: lead.skip, custom: {} } : { custom: lead.custom, input: lead };
            }
            case 'messageLists': {
                const list = mapMessageList(record);
                return 'skip' in list
                    ? { skip: list.skip, custom: {} }
                    : {
                          custom: { [TWENTY_LISTS_FIELD_KEY]: { type: 'multiselect', value: list.name } },
                          input: list,
                      };
            }
            case 'messageListMembers': {
                const member = mapMessageListMember(record, links);
                return 'skip' in member ? { skip: member.skip, custom: {} } : { custom: {}, input: member };
            }
            case 'messageCampaigns':
                return withCustom(mapMessageCampaign(record));
        }
    }

    /**
     * The definitions this page's custom values need, on the object they land on, through the
     * custom-fields service (so the cache every list reads is kept right): a new key is created
     * with the type its first value has, a select the page brings new options to grows them.
     */
    private async ensureDefinitions(object: TwentyImportObject, customs: InferredCustom[]): Promise<FieldDefinition[]> {
        const target = object === 'messageLists' || object === 'messageListMembers' ? 'person' : CUSTOM_OBJECT[object];
        if (!target || customs.every((c) => Object.keys(c).length === 0)) return [];
        const existing = await this.customFields.list({ object: target });
        const needed = definitionsNeeded(customs, existing);
        for (const definition of needed) {
            if (!definition.existing) {
                await this.customFields.create({
                    object: target,
                    key: definition.key,
                    label: definition.label,
                    type: definition.type,
                    options: definition.options,
                });
                continue;
            }
            const current = existing.find((d) => d.key === definition.key)!;
            if (current.archivedAt) await this.customFields.restore(current.id);
            if (definition.options.length > current.options.length) {
                await this.customFields.update(current.id, { options: definition.options });
            }
        }
        return this.rls.withWorkspace((tx) => this.customFields.activeDefinitions(tx, target));
    }

    private async write(
        tx: WorkspaceClient,
        state: RunState,
        object: TwentyImportObject,
        record: TwentyRecord,
        mapped: Exclude<MapResult, { skip: string } | { failed: string }>,
        links: LinkIndex,
        definitions: FieldDefinition[],
        events: DomainEvent[],
        kept: string[],
    ): Promise<Outcome> {
        const { context } = state;
        const workspaceId = context.workspaceId;
        const custom = customValuesFor(mapped.custom, definitions);
        /**
         * The precedence rule (#185) for a record mapped already: Twenty is the source for the fields
         * it maps, except one edited here after Twenty last touched the record — that keeps its value,
         * and the run report says so. A record Twenty gives no `updatedAt` for keeps every local edit.
         */
        const localEdits = async <I extends object>(type: RecordObject, localId: string, input: I): Promise<I> => {
            const touched = text(record.updatedAt);
            const edited = await fieldsEditedAfter(
                tx,
                { type, id: localId },
                touched ? new Date(touched) : new Date(0),
            );
            const result = withoutLocalEdits(input, edited);
            kept.push(...result.kept);
            return result.input;
        };
        const link = (localType: LocalType, localId: string, label: string | null = null) =>
            writeLink(tx, workspaceId, {
                object,
                externalId: record.id,
                localType,
                localId,
                label,
                externalUpdatedAt: text(record.updatedAt) ?? undefined,
            });
        const existing = links.link(object, record.id);

        switch (object) {
            case 'workspaceMembers': {
                const email = memberEmailOf(record);
                if (!email) return skip(mapped, 'no email');
                const member = await tx.workspaceMember.findFirst({ where: { user: { email } }, select: { id: true } });
                if (!member) return skip(mapped, `no member with email ${email}`);
                return (await link('member', member.id)) === 'created' ? 'created' : 'unchanged';
            }
            case 'companies': {
                const input = { ...(mapped.input as Parameters<CompaniesService['createIn']>[2]), custom };
                if (existing) {
                    const patch = await localEdits('company', existing.localId, input);
                    const result = await this.companies.updateIn(tx, context, existing.localId, patch);
                    if (result.event) events.push(result.event);
                    await link('company', existing.localId);
                    return result.event ? 'updated' : 'unchanged';
                }
                const match = input.domain ? await tx.company.findFirst({ where: { domain: input.domain } }) : null;
                if (match) {
                    if (match.deletedAt) events.push((await this.companies.restoreIn(tx, context, match.id)).event);
                    const result = await this.companies.updateIn(tx, context, match.id, input);
                    if (result.event) events.push(result.event);
                    await link('company', match.id);
                    return 'merged';
                }
                const created = await this.companies.createIn(tx, context, input);
                events.push(created.event);
                await link('company', created.row.id);
                return 'created';
            }
            case 'people':
            case 'leadViews': {
                const lead = object === 'leadViews' ? (mapped.input as MappedLeadView) : null;
                const input: PersonInput = { ...(lead ? lead.input : (mapped.input as PersonInput)), custom };
                // Twenty's person is the truth about a person; a lead only adds to one that exists.
                const authoritative = object === 'people';
                const target = existing?.localId ?? lead?.personId ?? null;
                if (target) {
                    const patch = existing && authoritative ? await localEdits('person', target, input) : input;
                    const result = await this.updatePerson(tx, context, target, patch, authoritative, events);
                    await link('person', target);
                    return result;
                }
                const email = input.emails?.primary ?? null;
                const match = email ? await tx.person.findFirst({ where: { emailPrimary: email } }) : null;
                if (match) {
                    if (match.deletedAt) events.push((await this.people.restoreIn(tx, context, match.id)).event);
                    await this.updatePerson(tx, context, match.id, input, authoritative, events);
                    await link('person', match.id);
                    return 'merged';
                }
                const created = await this.people.createIn(tx, context, input);
                events.push(created.event);
                await link('person', created.row.id);
                return 'created';
            }
            case 'opportunities': {
                const deal = mapped.input as MappedOpportunity;
                const input = { ...deal.input, custom };
                const stage = deal.stage ? await this.ensureStage(tx, state, deal.stage) : null;
                const actor = actorOf(context);
                const close = stage && stage.kind !== 'open' ? { lostReason: deal.lostReason ?? undefined } : undefined;
                if (existing) {
                    // The stage is a move, not a column: an edit here is `stageId` on the timeline.
                    const patch = await localEdits('opportunity', existing.localId, { ...input, stageId: stage?.id });
                    const { stageId: wantedStage, ...columns } = patch;
                    const result = await this.opportunities.updateIn(tx, context, existing.localId, columns);
                    if (result.event) events.push(result.event);
                    let moved = false;
                    if (stage && wantedStage && result.after.stageId !== stage.id) {
                        const outcome = await this.moves.move(tx, result.after, stage.id, actor, {
                            reason: 'import',
                            allowBackward: true,
                            close,
                        });
                        if (outcome.outcome === 'moved') {
                            await this.moves.announce(tx, workspaceId, result.after.id, actor, outcome);
                            moved = true;
                        }
                    }
                    await link('opportunity', existing.localId);
                    return result.event || moved ? 'updated' : 'unchanged';
                }
                const created = await this.opportunities.createIn(tx, context, {
                    ...input,
                    ...(stage && stage.kind === 'open' ? { stageId: stage.id } : {}),
                });
                events.push(created.event);
                if (stage && stage.kind !== 'open') {
                    const outcome = await this.moves.move(tx, created.row, stage.id, actor, {
                        reason: 'import',
                        allowBackward: true,
                        close,
                    });
                    if (outcome.outcome === 'moved')
                        await this.moves.announce(tx, workspaceId, created.row.id, actor, outcome);
                }
                await link('opportunity', created.row.id);
                return 'created';
            }
            case 'notes': {
                const input = mapped.input as Parameters<NotesService['createIn']>[2];
                if (existing) {
                    const result = await this.notes.updateIn(tx, context, existing.localId, input);
                    if (result.event) events.push(result.event);
                    await link('note', existing.localId);
                    return result.event ? 'updated' : 'unchanged';
                }
                const created = await this.notes.createIn(tx, context, input);
                events.push(created.event);
                await link('note', created.row.id);
                return 'created';
            }
            case 'tasks': {
                const input = mapped.input as Parameters<TasksService['createIn']>[2];
                if (existing) {
                    const result = await this.tasks.updateIn(tx, context, existing.localId, input);
                    if (result.event) events.push(result.event);
                    await link('task', existing.localId);
                    return result.event ? 'updated' : 'unchanged';
                }
                const created = await this.tasks.createIn(tx, context, input);
                events.push(created.event);
                await link('task', created.row.id);
                return 'created';
            }
            case 'leadLookups': {
                const lookup = mapped.input as Exclude<ReturnType<typeof mapLeadLookup>, { skip: string }>;
                if (lookup.action === 'exclude') {
                    const live = await tx.outreachExclusion.findFirst({
                        where: { address: lookup.address, removedAt: null },
                    });
                    if (live) {
                        await link('exclusion', live.id);
                        if (
                            live.source === TWENTY_IMPORT_SOURCE &&
                            live.accountManagerName !== lookup.accountManagerName
                        ) {
                            await tx.outreachExclusion.update({
                                where: { id: live.id },
                                data: { accountManagerName: lookup.accountManagerName, externalRef: record.id },
                            });
                            return 'updated';
                        }
                        return 'unchanged';
                    }
                    const added = await this.exclusions.addIn(tx, workspaceId, {
                        address: lookup.address,
                        reason: 'account_managed',
                        accountManagerName: lookup.accountManagerName,
                        source: TWENTY_IMPORT_SOURCE,
                        externalRef: record.id,
                    });
                    await link('exclusion', added.id);
                    return 'created';
                }
                const ours = await tx.outreachExclusion.findFirst({
                    where: {
                        removedAt: null,
                        source: TWENTY_IMPORT_SOURCE,
                        OR: [{ externalRef: record.id }, { address: lookup.address }],
                    },
                });
                if (!ours) return skip(mapped, 'not excluded here');
                await this.exclusions.removeIn(tx, ours.id, TWENTY_RELEASE_NOTE);
                await link('exclusion', ours.id);
                return 'updated';
            }
            case 'messageLists': {
                const { name } = mapped.input as { name: string };
                const viewName = `${TWENTY_LIST_VIEW_PREFIX}${name}`;
                if (existing) {
                    const current = await tx.savedView.findUnique({ where: { id: existing.localId } });
                    if (current && current.name === viewName) return 'unchanged';
                    if (current) await tx.savedView.update({ where: { id: current.id }, data: { name: viewName } });
                    await link('view', existing.localId, name);
                    return 'updated';
                }
                const created = await this.views.createIn(tx, context, 'person', {
                    name: viewName,
                    isShared: true,
                    filter: { and: [{ field: `custom.${TWENTY_LISTS_FIELD_KEY}`, op: 'contains', value: name }] },
                });
                await link('view', created.id, name);
                return 'created';
            }
            case 'messageListMembers': {
                const { personId, listName } = mapped.input as { personId: string; listName: string };
                const person = await tx.person.findUnique({ where: { id: personId }, select: { custom: true } });
                if (!person) return skip(mapped, 'person not in BylineCRM');
                const lists = stored<Record<string, unknown>>(person.custom)[TWENTY_LISTS_FIELD_KEY];
                const current = Array.isArray(lists) ? (lists as string[]) : [];
                await link('person', personId, listName);
                if (current.includes(listName)) return 'unchanged';
                const result = await this.people.updateIn(tx, context, personId, {
                    custom: { [TWENTY_LISTS_FIELD_KEY]: [...current, listName] },
                });
                if (result.event) events.push(result.event);
                return 'updated';
            }
            case 'messageCampaigns': {
                const input = mapped.input as Parameters<TemplatesService['createIn']>[2];
                if (existing) {
                    const result = await this.templates.updateIn(tx, context, existing.localId, input, null);
                    await link('template', existing.localId);
                    return Object.keys(result.diff).length > 0 ? 'updated' : 'unchanged';
                }
                const created = await this.templates.createIn(tx, context, input);
                await link('template', created.id);
                return 'created';
            }
        }
    }

    /**
     * Writes a person that exists. Twenty's person record overwrites; a lead record only fills
     * what is empty and adds its custom values, so a person's own fields are never replaced by a
     * sidecar's.
     */
    private async updatePerson(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        personId: string,
        input: PersonInput,
        authoritative: boolean,
        events: DomainEvent[],
    ): Promise<Outcome> {
        let patch = input;
        if (!authoritative) {
            const current = await tx.person.findUniqueOrThrow({ where: { id: personId } });
            const emails = stored<{ primary: string | null; additional: string[] }>(current.emails);
            const phones = stored<{ primary: unknown }>(current.phones);
            const links = stored<{ linkedin: unknown; x: unknown }>(current.links);
            patch = {
                custom: input.custom,
                ...(current.nameFirst === '' && current.nameLast === '' && (input.nameFirst || input.nameLast)
                    ? { nameFirst: input.nameFirst, nameLast: input.nameLast }
                    : {}),
                ...(emails.primary === null && input.emails?.primary ? { emails: input.emails } : {}),
                ...(phones.primary === null && input.phones?.primary ? { phones: input.phones } : {}),
                ...(links.linkedin === null &&
                links.x === null &&
                input.links &&
                (input.links.linkedin || input.links.x)
                    ? { links: input.links }
                    : {}),
                ...(current.source === null && input.source ? { source: input.source } : {}),
            };
        }
        const result = await this.people.updateIn(tx, context, personId, patch);
        if (result.event) events.push(result.event);
        return result.event ? 'updated' : 'unchanged';
    }

    /** The default pipeline's stage of that name, made if the pipeline has none, remembered for the run. */
    private async ensureStage(
        tx: WorkspaceClient,
        state: RunState,
        stage: { name: string; kind: StageKind },
    ): Promise<{ id: string; kind: StageKind }> {
        const key = stage.name.toLowerCase();
        const known = state.stages.get(key);
        if (known) return known;
        const pipeline = await tx.pipeline.findFirst({ where: { isDefault: true }, select: { id: true } });
        if (!pipeline) throw new ApiException(422, 'unprocessable', 'this workspace has no default pipeline');
        const stages = await tx.pipelineStage.findMany({
            where: { pipelineId: pipeline.id },
            orderBy: { position: 'asc' },
        });
        let found = stages.find((s) => s.name.toLowerCase() === key);
        if (!found) {
            found = await tx.pipelineStage.create({
                data: stageData(state.context.workspaceId, pipeline.id, (stages.at(-1)?.position ?? 0) + 1, {
                    name: stage.name,
                    probability: stage.kind === 'won' ? 100 : stage.kind === 'lost' ? 0 : 10,
                    kind: stage.kind,
                    colour: stage.kind === 'won' ? 'ok' : stage.kind === 'lost' ? 'bad' : 'neutral',
                }),
            });
        }
        const resolved = { id: found.id, kind: found.kind as StageKind };
        state.stages.set(key, resolved);
        return resolved;
    }

    /** Every member Twenty has deactivated (soft-deleted), by id: a candidate account only when a record is theirs. */
    private async readDeactivatedMembers(connection: TwentyConnection): Promise<Map<string, TwentyRecord>> {
        const found = new Map<string, TwentyRecord>();
        let cursor: string | null = null;
        for (;;) {
            let page: TwentyPage;
            try {
                page = await this.twenty.list(connection, 'workspaceMembers', { cursor, depth: 0, deleted: true });
            } catch (error) {
                // A Twenty that will not list deleted members has, for the import, none.
                if (
                    error instanceof TwentyApiError &&
                    error.permanent &&
                    error.status !== 401 &&
                    error.status !== 403
                ) {
                    return found;
                }
                throw error;
            }
            for (const record of page.records) found.set(record.id, record);
            if (!page.hasNextPage || page.records.length === 0 || !page.endCursor) return found;
            cursor = page.endCursor;
        }
    }

    /**
     * The member pass with the accounts option (#184): a Twenty member with a usable address and no
     * seat here (held or left) gets a user and a seat with the run's role. The pass's write then
     * matches them by address and links them like any member.
     */
    private async provisionMembers(state: RunState, records: TwentyRecord[]): Promise<void> {
        for (const record of records) {
            const email = memberEmailOf(record);
            if (!email) continue;
            const seat = await this.rls.withWorkspace((tx) =>
                tx.workspaceMember.findFirst({ where: { user: { email } }, select: { id: true } }),
            );
            if (seat) continue;
            const made = await this.auth.provisionMember({
                workspaceId: state.context.workspaceId,
                email,
                displayName: memberNameOf(record),
                roleId: state.membersRoleId!,
            });
            if (made.createdSeat) state.accountsCreated += 1;
        }
    }

    /**
     * A page refers to members Twenty deactivated (#184): each one not mapped yet gets an account and
     * a seat already left (`left_at`: history attributed, no access), linked here so the page's
     * records resolve their owner. A deactivated member no record names is never made.
     */
    private async provisionDeactivatedOwners(state: RunState, refs: readonly LinkRef[]): Promise<void> {
        const wanted = [
            ...new Set(
                refs
                    .filter((ref) => ref.object === 'workspaceMembers' && state.deactivated.has(ref.externalId))
                    .map((ref) => ref.externalId),
            ),
        ];
        if (wanted.length === 0) return;
        const linked = await this.rls.withWorkspace((tx) =>
            loadLinks(
                tx,
                wanted.map((externalId) => ({ object: 'workspaceMembers' as const, externalId })),
            ),
        );
        for (const externalId of wanted) {
            if (linked.link('workspaceMembers', externalId)) continue;
            const record = state.deactivated.get(externalId)!;
            const email = memberEmailOf(record);
            if (!email) continue;
            const leftAt = text(record.deletedAt) ? new Date(text(record.deletedAt)!) : new Date();
            const made = await this.auth.provisionMember({
                workspaceId: state.context.workspaceId,
                email,
                displayName: memberNameOf(record),
                roleId: state.membersRoleId!,
                leftAt,
            });
            if (made.createdSeat) state.accountsCreated += 1;
            await this.rls.withWorkspace((tx) =>
                writeLink(tx, state.context.workspaceId, {
                    object: 'workspaceMembers',
                    externalId,
                    localType: 'member',
                    localId: made.memberId,
                    label: null,
                    externalUpdatedAt: text(record.updatedAt) ?? undefined,
                }),
            );
        }
    }

    private cancelRequested(runId: string): Promise<boolean> {
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.twentyImportRun.findUnique({
                where: { id: runId },
                select: { cancelRequested: true },
            });
            return row?.cancelRequested === true;
        });
    }

    private saveProgress(state: RunState): Promise<unknown> {
        return this.rls.withWorkspace((tx) =>
            tx.twentyImportRun.update({
                where: { id: state.runId },
                data: {
                    phase: state.phase ?? null,
                    cursor: state.cursors,
                    report: state.report as unknown as Prisma.InputJsonValue,
                    accountsCreated: state.accountsCreated,
                },
            }),
        );
    }

    private async finish(
        runId: string,
        status: 'succeeded' | 'failed' | 'cancelled',
        error?: string,
        state?: RunState,
    ): Promise<void> {
        await this.rls.withWorkspace(async (tx) => {
            const row = await tx.twentyImportRun.update({
                where: { id: runId },
                data: {
                    status,
                    error: error ?? null,
                    finishedAt: new Date(),
                    phase: null,
                    ...(state
                        ? {
                              cursor: state.cursors,
                              report: state.report as unknown as Prisma.InputJsonValue,
                              accountsCreated: state.accountsCreated,
                          }
                        : {}),
                },
            });
            // A scheduled run's end is the schedule's record (#185): the streak, and the admins' notice.
            await this.sync.recordOutcome(tx, row);
        });
    }
}

interface RunState {
    runId: string;
    context: WorkspaceRunContext;
    connection: TwentyConnection;
    cursors: Cursors;
    report: TwentyImportObjectReport[];
    since: string | null;
    mode: TwentyImportMode;
    /** When this run first started: a reconcile pass flags what was not checked at or after it. */
    passStartedAt: Date;
    phase?: TwentyImportObject;
    stages: Map<string, { id: string; kind: StageKind }>;
    /** #184: the role for accounts the run makes for Twenty members who are not here; null without the option. */
    membersRoleId: string | null;
    accountsCreated: number;
    /** #184: members Twenty deactivated, by id — made here only when a record of this run is theirs. */
    deactivated: Map<string, TwentyRecord>;
}

/** A Twenty member's display name, as their account here starts with it: first and last name, or none. */
function memberNameOf(record: TwentyRecord): string | null {
    const name = isObject(record.name) ? record.name : null;
    const full = [text(name?.firstName), text(name?.lastName)].filter((part) => part).join(' ');
    return full || null;
}

/** A mapped record on its way to a write: the service input (shape by object), its custom values, or why it is skipped. */
type MapResult =
    | { custom: InferredCustom; input: unknown; note?: string }
    | { skip: string; custom: InferredCustom }
    // The mapper threw (#168): the record is reported as failed with what it said.
    | { failed: string; custom: InferredCustom };

function withCustom<I>(mapped: { input: I; custom: InferredCustom } | { skip: string }): MapResult {
    return 'skip' in mapped ? { skip: mapped.skip, custom: {} } : { custom: mapped.custom, input: mapped.input };
}

/** A record the write decided has no place here: counted as skipped, with the reason on the record. */
function skip(mapped: { note?: string }, reason: string): 'skipped' {
    mapped.note = reason;
    return 'skipped';
}

function reportFrom(saved: TwentyImportObjectReport[]): TwentyImportObjectReport[] {
    return TWENTY_IMPORT_OBJECTS.map((object) => saved.find((r) => r.object === object) ?? emptyObjectReport(object));
}

function reportEntry(report: TwentyImportObjectReport[], object: TwentyImportObject): TwentyImportObjectReport {
    return report.find((r) => r.object === object)!;
}

function recordError(entry: TwentyImportObjectReport, externalId: string, message: string): void {
    if (entry.errors.length < TWENTY_IMPORT_ERRORS_KEPT) entry.errors.push({ externalId, message });
}

/** A record whose BylineCRM values were kept over Twenty's (#185): counted, and named while the list has room. */
function recordKept(entry: TwentyImportObjectReport, externalId: string, fields: string[]): void {
    entry.conflicts += 1;
    if (entry.kept.length < TWENTY_IMPORT_ERRORS_KEPT) entry.kept.push({ externalId, fields });
}

/**
 * What a thrown error says, as the report shows it (#168): its last line — a client's validation
 * message ends with the point; the lines before quote the whole call — trimmed to a report's width.
 */
export function failureText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const last = message
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .at(-1);
    return (last ?? 'failed').slice(0, TWENTY_IMPORT_ERROR_MESSAGE_MAX);
}

/** What a service's refusal says, as the report shows it: the field errors when it names fields, else its message. */
function refusalText(error: HttpException): string {
    if (error instanceof ApiException && error.fieldErrors?.length) {
        return error.fieldErrors.map((f) => `${f.path}: ${f.message}`).join('; ');
    }
    return error.message;
}
