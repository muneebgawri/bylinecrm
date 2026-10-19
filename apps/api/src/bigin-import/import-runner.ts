import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import {
    BIGIN_IMPORT_OBJECTS,
    TWENTY_IMPORT_ERRORS_KEPT,
    plainBiginId,
    type BiginImportMode,
    type BiginImportObject,
    type BiginImportObjectReport,
    type Capability,
    type DomainEvent,
    type RecordObject,
    type RecordTarget,
    type StageKind,
} from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { DomainEvents } from '../events/domain-events.service';
import { localsByBiginRecordId, type CrossSourceType } from '../import-common/cross-source';
import { ApiException } from '../infra/errors/api-errors';
import { databaseUnavailable } from '../infra/prisma-errors';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { StageMoveService } from '../pipelines/stage-move.service';
import { actorOf } from '../records/actor';
import { CompaniesService, type CompanyInput } from '../records/companies.service';
import { companyDomain } from '../records/company-domain';
import { CustomFieldsService } from '../records/custom-fields/custom-fields.service';
import type { FieldDefinition } from '../records/custom-fields/custom-values';
import { NotesService, type NoteInput } from '../records/notes.service';
import { OpportunitiesService } from '../records/opportunities.service';
import { PeopleService, type PersonInput } from '../records/people.service';
import { defaultCurrency, stored } from '../records/references';
import { fieldsEditedAfter } from '../timeline/timeline.service';
import { customValuesFor, definitionsNeeded, type InferredCustom } from '../twenty-import/custom-fields-sync';
import { failureText } from '../twenty-import/import-runner';
import { withoutLocalEdits } from '../twenty-import/twenty-sync';
import { readBiginConnection, biginReportFrom } from './bigin-import.settings';
import { BIGIN_PAGE_MAX } from './bigin-import.constants';
import { BiginSyncService } from './bigin-sync.service';
import { isContactReused, reuseNoteText, type ContactIdentity } from './contact-reuse';
import { markdownToRichText } from '../twenty-import/markdown';
import { BiginApiError } from './bigin.http';
import { BIGIN_PORT, type BiginApi, type BiginConnection, type BiginRecord } from './bigin.port';
import {
    advanceWindow,
    biginInstant,
    noteFailure,
    noteSuccess,
    settledCursor,
    startPass,
    type BiginPassCursor,
} from './cursor-policy';
import { countBiginLinks, flagBiginDeleted, loadBiginLinks, writeBiginLink, type BiginLocalType } from './links';
import {
    mapAccount,
    mapContact,
    mapDeal,
    mapNote,
    ownerEmailOf,
    ownerNameOf,
    referencesOf,
    type MappedDeal,
} from './mappers';

/** The runner writes records only: no capability beyond what an import writes without one. */
const JOB_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>();

/** What each module becomes here, and the record object its custom values and history live on. */
const LOCAL: Readonly<Record<BiginImportObject, BiginLocalType>> = {
    Accounts: 'company',
    Contacts: 'person',
    Deals: 'opportunity',
    Notes: 'note',
};

type Outcome = 'created' | 'updated' | 'unchanged' | 'merged' | 'skipped';
type Cursors = Partial<Record<BiginImportObject, BiginPassCursor>>;
type MapResult =
    | { input: unknown; custom: InferredCustom; ownerEmail: string | null; note?: string }
    | { skip: string; custom: InferredCustom }
    | { failed: string; custom: InferredCustom };

interface StageChoice {
    id: string;
    kind: StageKind;
    /** Bigin's stage had no stage of its name here: the deal went to the first open stage. */
    unknown: boolean;
}

interface RunState {
    runId: string;
    context: WorkspaceRunContext;
    connection: BiginConnection;
    mode: BiginImportMode;
    cursors: Cursors;
    report: BiginImportObjectReport[];
    /** The workspace's module cursors as the run found them: a `changes` pass reads from them. */
    settingsCursors: Record<string, string>;
    passStartedAt: Date;
    phase?: BiginImportObject;
    stages: { id: string; name: string; kind: StageKind }[] | null;
    membersRoleId: string | null;
    accountsCreated: number;
}

/**
 * Drives one Bigin import run (BIGIN-1, FR-CRMS-25) — the Twenty importer's runner (P4-4) for Bigin's
 * modules. The run row is the truth: each module's pass cursor and the report are written in the same
 * transaction as each page's records, so a run that dies resumes from the page after the last one
 * committed. Every page is read from Bigin outside any transaction and written through the services
 * the routes use, as the import (`actor: { kind: 'import' }`). A record maps by its Bigin id
 * (`bigin_import_links`); one not mapped yet is matched — the record the Twenty importer made from the
 * same Bigin record (its `biginrecordid`), a person by address, a company by registrable domain — before
 * one is created. The module's cursor (on the settings row) moves with every page: past what
 * succeeded, never past the oldest record that failed. Bigin's deletions are flagged for review.
 */
@Injectable()
export class BiginImportRunner {
    private readonly logger = new Logger(BiginImportRunner.name);

    constructor(
        private readonly ownerPrisma: PrismaService,
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        @Inject(BIGIN_PORT) private readonly bigin: BiginApi,
        private readonly events: DomainEvents,
        private readonly customFields: CustomFieldsService,
        private readonly people: PeopleService,
        private readonly companies: CompaniesService,
        private readonly opportunities: OpportunitiesService,
        private readonly notes: NotesService,
        private readonly moves: StageMoveService,
        private readonly sync: BiginSyncService,
        private readonly auth: AuthService,
    ) {}

    /** Runs `runId` to its end — succeeded, failed, cancelled — or throws so the queue retries it from its cursor. */
    async run(runId: string): Promise<void> {
        const head = await this.ownerPrisma.biginImportRun.findUnique({
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
        const head = await this.ownerPrisma.biginImportRun.findUnique({
            where: { id: runId },
            select: { workspaceId: true },
        });
        if (!head) return;
        await this.rls.withWorkspace(head.workspaceId, async (tx) => {
            const { count } = await tx.biginImportRun.updateMany({
                where: { id: runId, status: { in: ['queued', 'running'] } },
                data: { status: 'failed', error, finishedAt: new Date(), phase: null },
            });
            if (count === 0) return;
            await this.sync.recordOutcome(tx, await tx.biginImportRun.findUniqueOrThrow({ where: { id: runId } }));
        });
    }

    private async execute(runId: string): Promise<void> {
        const context = this.context.get()!;
        const opened = await this.rls.withWorkspace(async (tx) => {
            const run = await tx.biginImportRun.findUniqueOrThrow({ where: { id: runId } });
            return { run, stored: await readBiginConnection(tx, this.secrets) };
        });
        if (opened.run.cancelRequested) return this.finish(runId, 'cancelled');
        if (!opened.stored) return this.finish(runId, 'failed', 'the Bigin connection was removed');
        const startedAt = opened.run.startedAt ?? new Date();
        await this.rls.withWorkspace((tx) =>
            tx.biginImportRun.update({
                where: { id: runId },
                data: { status: 'running', startedAt, error: null },
            }),
        );
        const state: RunState = {
            runId,
            context,
            connection: opened.stored.connection,
            mode: opened.run.mode,
            cursors: stored<Cursors>(opened.run.cursor),
            report: biginReportFrom(opened.run.report),
            settingsCursors: stored<Record<string, string>>(opened.stored.row.cursors),
            passStartedAt: startedAt,
            stages: null,
            membersRoleId: opened.run.createMembersRoleId,
            accountsCreated: opened.run.accountsCreated,
        };
        try {
            for (const module of BIGIN_IMPORT_OBJECTS) {
                const cursor = state.cursors[module];
                if (cursor?.done && cursor.deletedDone) continue;
                const done = await this.readModule(state, module);
                if (!done) return this.finish(runId, 'cancelled', undefined, state);
            }
            await this.finish(runId, 'succeeded', undefined, state);
        } catch (error) {
            if (error instanceof BiginApiError && error.permanent) {
                await this.finish(runId, 'failed', error.message, state);
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`bigin import run ${runId} interrupted on ${state.phase ?? '-'}: ${message}`);
            await this.rls.withWorkspace((tx) =>
                tx.biginImportRun.update({ where: { id: runId }, data: { error: message } }),
            );
            throw error;
        }
    }

    /** Reads one module from where the run left it, then its deletions; `false` when a cancel was asked for. */
    private async readModule(state: RunState, module: BiginImportObject): Promise<boolean> {
        state.phase = module;
        const entry = reportEntry(state.report, module);
        let cursor = state.cursors[module];
        if (!cursor) {
            entry.before = await this.rls.withWorkspace((tx) => countBiginLinks(tx, module));
            entry.remote = await this.bigin.count(state.connection, module);
            const changes = state.mode === 'changes';
            cursor = startPass(
                changes ? (state.settingsCursors[module] ?? null) : null,
                changes ? (state.settingsCursors[deletedKey(module)] ?? null) : null,
            );
            state.cursors[module] = cursor;
        }
        while (!cursor.done) {
            const page = await this.bigin.list(state.connection, module, { since: cursor.since, page: cursor.page });
            await this.writePage(state, module, cursor, page.records, page.moreRecords, entry);
            if (cursor.done) break;
            if (await this.cancelRequested(state.runId)) return false;
        }
        let truncated = false;
        while (!cursor.deletedDone) {
            const page = await this.bigin.deleted(state.connection, module, {
                since: cursor.deletedSince,
                page: cursor.deletedPage,
            });
            await this.rls.withWorkspace(async (tx) => {
                entry.missingInSource += await flagBiginDeleted(
                    tx,
                    module,
                    page.records.map((r) => ({
                        id: plainBiginId(r.id)!,
                        at: biginInstant(r.deletedTime) ?? new Date(),
                    })),
                );
                if (!page.moreRecords || page.records.length === 0) cursor.deletedDone = true;
                else if (cursor.deletedPage >= BIGIN_PAGE_MAX) {
                    // More deletions than one pass may page through: the rest are read next run (the cursor stays).
                    cursor.deletedDone = true;
                    truncated = true;
                } else cursor.deletedPage += 1;
                await this.saveProgress(tx, state);
            });
        }
        await this.rls.withWorkspace(async (tx) => {
            entry.after = await countBiginLinks(tx, module);
            const settled = settledCursor({
                previous: state.settingsCursors[module] ?? null,
                cursor,
                passStartedAt: state.passStartedAt,
                complete: true,
            });
            const deleted = truncated
                ? (state.settingsCursors[deletedKey(module)] ?? null)
                : new Date(state.passStartedAt.getTime() - 1000).toISOString();
            await this.saveModuleCursors(tx, state, module, settled, deleted);
            await this.saveProgress(tx, state);
        });
        return true;
    }

    /**
     * One page: owners made if the run makes accounts, the links and cross-source matches its records need
     * read, the records mapped, then every record written — each under a savepoint, so one the services
     * refuse costs only itself — with the pass cursor, the module's cursor and the run's progress saved in
     * the same transaction as the writes.
     */
    private async writePage(
        state: RunState,
        module: BiginImportObject,
        cursor: BiginPassCursor,
        all: BiginRecord[],
        moreRecords: boolean,
        entry: BiginImportObjectReport,
    ): Promise<void> {
        const seen = new Set(cursor.seen);
        const records = all.filter((record) => !seen.has(plainBiginId(record.id) ?? ''));
        const emails = [...new Set(records.map(ownerEmailOf).filter((e): e is string => e !== null))];
        if (state.membersRoleId) await this.provisionOwners(state, records);
        const refs = records.flatMap((record) => referencesOf(module, record));
        const workspaceId = state.context.workspaceId;
        const { links, members, currency, cross } = await this.rls.withWorkspace(async (tx) => {
            const links = await loadBiginLinks(tx, refs);
            const seats =
                emails.length === 0
                    ? []
                    : await tx.workspaceMember.findMany({
                          where: { user: { email: { in: emails } } },
                          select: { id: true, user: { select: { email: true } } },
                      });
            const type = LOCAL[module];
            const unlinked = records
                .map((r) => plainBiginId(r.id))
                .filter((id): id is string => id !== null && !links.link(module, id));
            const cross =
                type === 'note'
                    ? new Map<string, string>()
                    : await localsByBiginRecordId(tx, workspaceId, type, unlinked);
            return {
                links,
                members: new Map(seats.map((s) => [s.user.email, s.id])),
                currency: await defaultCurrency(tx, workspaceId),
                cross,
            };
        });
        const mapped = records.map((record) => {
            try {
                return { record, result: this.map(module, record, links, currency) };
            } catch (error) {
                return { record, result: { failed: failureText(error), custom: {} } as MapResult };
            }
        });
        const definitions =
            module === 'Contacts'
                ? await this.ensureDefinitions(
                      'person',
                      mapped.map((m) => m.result.custom),
                  )
                : [];
        await this.rls.withWorkspace(async (tx) => {
            const events: DomainEvent[] = [];
            let latest: Date | null = null;
            for (const { record, result } of mapped) {
                const modified = biginInstant(record.Modified_Time);
                if (modified && (!latest || modified > latest)) latest = modified;
                const externalId = plainBiginId(record.id) ?? '-';
                entry.read += 1;
                if ('failed' in result) {
                    entry.failed += 1;
                    recordError(entry, externalId, result.failed);
                    noteFailure(cursor, modified);
                    continue;
                }
                if ('skip' in result) {
                    entry.skipped += 1;
                    recordError(entry, externalId, result.skip);
                    noteSuccess(cursor, modified);
                    continue;
                }
                await tx.$executeRawUnsafe('SAVEPOINT bigin_record');
                try {
                    const kept: string[] = [];
                    const outcome = await this.write(tx, state, module, record, result, {
                        links,
                        members,
                        cross,
                        definitions,
                        events,
                        kept,
                        entry,
                    });
                    await tx.$executeRawUnsafe('RELEASE SAVEPOINT bigin_record');
                    entry[outcome] += 1;
                    if (outcome === 'skipped' && result.note) recordError(entry, externalId, result.note);
                    if (kept.length > 0) {
                        entry.conflicts += 1;
                        if (entry.kept.length < TWENTY_IMPORT_ERRORS_KEPT)
                            entry.kept.push({ externalId, fields: kept });
                    }
                    noteSuccess(cursor, modified);
                } catch (error) {
                    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT bigin_record');
                    if (databaseUnavailable(error) || error instanceof BiginApiError) throw error;
                    entry.failed += 1;
                    recordError(
                        entry,
                        externalId,
                        error instanceof HttpException ? refusalText(error) : failureText(error),
                    );
                    noteFailure(cursor, modified);
                }
            }
            await this.events.recordAll(tx, events);
            for (const record of all) {
                const modified = biginInstant(record.Modified_Time);
                if (modified && (!latest || modified > latest)) latest = modified;
            }
            advanceWindow(cursor, {
                ids: all.map((r) => plainBiginId(r.id)).filter((id): id is string => id !== null),
                latest,
                moreRecords: moreRecords && all.length > 0,
            });
            // Progress the workspace keeps even if this run never finishes: up to what this pass wrote.
            const settled = settledCursor({
                previous: state.settingsCursors[module] ?? null,
                cursor,
                passStartedAt: state.passStartedAt,
                complete: false,
            });
            await this.saveModuleCursors(tx, state, module, settled, undefined);
            await this.saveProgress(tx, state);
        });
    }

    private map(
        module: BiginImportObject,
        record: BiginRecord,
        links: Parameters<typeof mapContact>[1],
        currency: string,
    ): MapResult {
        switch (module) {
            case 'Accounts':
                return asResult(mapAccount(record));
            case 'Contacts':
                return asResult(mapContact(record, links));
            case 'Deals':
                return asResult(mapDeal(record, links, currency));
            case 'Notes':
                return asResult(mapNote(record, links));
        }
    }

    private async ensureDefinitions(target: RecordObject, customs: InferredCustom[]): Promise<FieldDefinition[]> {
        if (customs.every((c) => Object.keys(c).length === 0)) return [];
        const existing = await this.customFields.list({ object: target });
        for (const definition of definitionsNeeded(customs, existing)) {
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
        }
        return this.rls.withWorkspace((tx) => this.customFields.activeDefinitions(tx, target));
    }

    private async write(
        tx: WorkspaceClient,
        state: RunState,
        module: BiginImportObject,
        record: BiginRecord,
        mapped: Extract<MapResult, { input: unknown }>,
        page: {
            links: Awaited<ReturnType<typeof loadBiginLinks>>;
            members: Map<string, string>;
            cross: Map<string, string>;
            definitions: FieldDefinition[];
            events: DomainEvent[];
            kept: string[];
            entry: BiginImportObjectReport;
        },
    ): Promise<Outcome> {
        const { context } = state;
        const { events } = page;
        const externalId = plainBiginId(record.id);
        if (!externalId) throw new Error('the record has no id');
        const modified = biginInstant(record.Modified_Time);
        const ownerId = mapped.ownerEmail ? (page.members.get(mapped.ownerEmail) ?? null) : null;
        const type = LOCAL[module];
        /**
         * The precedence rule (the Twenty sync's, #185): Bigin is the source for the fields it maps, except
         * one edited here after Bigin last modified the record — that keeps BylineCRM's value, and the report
         * says so. The owner is set when a record is created and never after: who owns it here is BylineCRM's.
         */
        const localEdits = async <I extends object>(object: RecordObject, localId: string, input: I): Promise<I> => {
            const edited = await fieldsEditedAfter(tx, { type: object, id: localId }, modified ?? new Date(0));
            const result = withoutLocalEdits(input, edited);
            page.kept.push(...result.kept);
            return result.input;
        };
        const contactInput = module === 'Contacts' ? (mapped.input as PersonInput) : null;
        /** A Contact's identity as Bigin has it now, kept on its link: what a later reuse is detected against. */
        const identity = contactInput
            ? {
                  name: [contactInput.nameFirst, contactInput.nameLast].filter((p) => p).join(' '),
                  email: contactInput.emails?.primary ?? null,
              }
            : null;
        const link = (localId: string) =>
            writeBiginLink(tx, context.workspaceId, {
                object: module,
                externalId,
                localType: type,
                localId,
                externalUpdatedAt: modified,
                snapshot: identity,
            });
        const linked = page.links.link(module, externalId)?.localId ?? null;
        /** The record this one already is: its own link, else the one the Twenty importer made from it. */
        const known = async (): Promise<{ id: string; how: 'linked' | 'merged' } | 'trashed' | null> => {
            const id = linked ?? page.cross.get(externalId) ?? null;
            if (!id) return null;
            if (await trashed(tx, type as CrossSourceType | 'note', id)) return linked ? 'trashed' : null;
            return { id, how: linked ? 'linked' : 'merged' };
        };

        switch (module) {
            case 'Accounts': {
                const input = { ...(mapped.input as CompanyInput & { name: string }) };
                const found = await known();
                if (found === 'trashed') return skip(mapped, 'trashed in BylineCRM');
                if (found) {
                    const patch = await localEdits('company', found.id, input);
                    const result = await this.companies.updateIn(tx, context, found.id, patch);
                    if (result.event) events.push(result.event);
                    await link(found.id);
                    return found.how === 'merged' ? 'merged' : result.event ? 'updated' : 'unchanged';
                }
                const domain = input.domain ? (companyDomain(input.domain) ?? input.domain) : null;
                const match = domain ? await tx.company.findFirst({ where: { domain } }) : null;
                if (match) {
                    if (match.deletedAt) events.push((await this.companies.restoreIn(tx, context, match.id)).event);
                    const patch = await localEdits('company', match.id, input);
                    const result = await this.companies.updateIn(tx, context, match.id, patch);
                    if (result.event) events.push(result.event);
                    await link(match.id);
                    return 'merged';
                }
                const created = await this.companies.createIn(tx, context, { ...input, ownerId });
                events.push(created.event);
                await link(created.row.id);
                return 'created';
            }
            case 'Contacts': {
                const custom = customValuesFor(mapped.custom, page.definitions);
                const input: PersonInput = { ...(mapped.input as PersonInput), custom };
                const found = await known();
                if (found === 'trashed') return skip(mapped, 'trashed in BylineCRM');
                if (found && found.how === 'linked' && identity) {
                    const before =
                        page.links.link(module, externalId)?.snapshot ?? (await currentIdentity(tx, found.id));
                    if (isContactReused(before, identity)) {
                        page.entry.reused += 1;
                        return this.reuseContact(tx, state, {
                            externalId,
                            previousPersonId: found.id,
                            input,
                            ownerId,
                            before,
                            after: identity,
                            changedAt: modified ?? new Date(),
                            events,
                            link,
                        });
                    }
                }
                if (found) {
                    const patch = await localEdits('person', found.id, input);
                    const result = await this.people.updateIn(tx, context, found.id, patch);
                    if (result.event) events.push(result.event);
                    await link(found.id);
                    return found.how === 'merged' ? 'merged' : result.event ? 'updated' : 'unchanged';
                }
                const email = input.emails?.primary ?? null;
                const match = email ? await tx.person.findFirst({ where: { emailPrimary: email } }) : null;
                if (match) {
                    if (match.deletedAt) events.push((await this.people.restoreIn(tx, context, match.id)).event);
                    const patch = await localEdits('person', match.id, input);
                    const result = await this.people.updateIn(tx, context, match.id, patch);
                    if (result.event) events.push(result.event);
                    await link(match.id);
                    return 'merged';
                }
                const created = await this.people.createIn(tx, context, { ...input, ownerId });
                events.push(created.event);
                await link(created.row.id);
                return 'created';
            }
            case 'Deals': {
                const deal = mapped as unknown as MappedDeal;
                const stage = await this.resolveStage(tx, state, deal.stage);
                if (stage.unknown && deal.stage && page.entry.unknownStages.length < TWENTY_IMPORT_ERRORS_KEPT) {
                    page.entry.unknownStages.push({ externalId, stage: deal.stage });
                }
                const actor = actorOf(context);
                const close = stage.kind !== 'open' ? { lostReason: undefined } : undefined;
                const found = await known();
                if (found === 'trashed') return skip(mapped, 'trashed in BylineCRM');
                if (found) {
                    // The stage is a move, not a column: an edit here is `stageId` on the timeline.
                    const patch = await localEdits('opportunity', found.id, { ...deal.input, stageId: stage.id });
                    const { stageId: wanted, ...columns } = patch;
                    const result = await this.opportunities.updateIn(tx, context, found.id, columns);
                    if (result.event) events.push(result.event);
                    let moved = false;
                    if (wanted && result.after.stageId !== stage.id) {
                        const outcome = await this.moves.move(tx, result.after, stage.id, actor, {
                            reason: 'import',
                            allowBackward: true,
                            close,
                        });
                        if (outcome.outcome === 'moved') {
                            await this.moves.announce(tx, context.workspaceId, result.after.id, actor, outcome);
                            moved = true;
                        }
                    }
                    await link(found.id);
                    return found.how === 'merged' ? 'merged' : result.event || moved ? 'updated' : 'unchanged';
                }
                const created = await this.opportunities.createIn(tx, context, {
                    ...deal.input,
                    ownerId,
                    ...(stage.kind === 'open' ? { stageId: stage.id } : { stageId: this.firstOpen(state).id }),
                });
                events.push(created.event);
                if (stage.kind !== 'open') {
                    // A closed deal is created open and closed through the one stage writer: it has its history and event.
                    const outcome = await this.moves.move(tx, created.row, stage.id, actor, {
                        reason: 'import',
                        allowBackward: true,
                        close,
                    });
                    if (outcome.outcome === 'moved')
                        await this.moves.announce(tx, context.workspaceId, created.row.id, actor, outcome);
                }
                await link(created.row.id);
                return 'created';
            }
            case 'Notes': {
                const input = mapped.input as NoteInput & { targets: RecordTarget[] };
                const found = await known();
                if (found === 'trashed') return skip(mapped, 'trashed in BylineCRM');
                if (found) {
                    const result = await this.notes.updateIn(tx, context, found.id, input);
                    if (result.event) events.push(result.event);
                    await link(found.id);
                    return result.event ? 'updated' : 'unchanged';
                }
                const created = await this.notes.createIn(tx, context, { ...input, authorId: ownerId });
                events.push(created.event);
                await link(created.row.id);
                return 'created';
            }
        }
    }

    /**
     * A Bigin Contact edited to hold a different person (BIGIN-1): the earlier person is left as it was (it
     * is the earlier lead) with a note saying so; the new identity becomes a person of its own (matched by
     * address first, as any Contact is, else created with Bigin's owner), the link moves to them, and the
     * reuse is recorded for admins. Records made in Bigin after the change resolve to the new person.
     */
    private async reuseContact(
        tx: WorkspaceClient,
        state: RunState,
        reuse: {
            externalId: string;
            previousPersonId: string;
            input: PersonInput;
            ownerId: string | null;
            before: ContactIdentity;
            after: ContactIdentity;
            changedAt: Date;
            events: DomainEvent[];
            link: (localId: string) => Promise<void>;
        },
    ): Promise<Outcome> {
        const { context } = state;
        const note = await this.notes.createIn(tx, context, {
            title: 'Bigin contact reused',
            body: markdownToRichText(reuseNoteText(reuse.changedAt)),
            targets: [{ type: 'person', id: reuse.previousPersonId }],
            authorId: null,
        });
        reuse.events.push(note.event);
        const email = reuse.input.emails?.primary ?? null;
        const match = email
            ? await tx.person.findFirst({ where: { emailPrimary: email, id: { not: reuse.previousPersonId } } })
            : null;
        let personId: string;
        let outcome: Outcome;
        if (match) {
            if (match.deletedAt) reuse.events.push((await this.people.restoreIn(tx, context, match.id)).event);
            const result = await this.people.updateIn(tx, context, match.id, reuse.input);
            if (result.event) reuse.events.push(result.event);
            personId = match.id;
            outcome = 'merged';
        } else {
            const created = await this.people.createIn(tx, context, { ...reuse.input, ownerId: reuse.ownerId });
            reuse.events.push(created.event);
            personId = created.row.id;
            outcome = 'created';
        }
        await tx.biginContactReuse.create({
            data: {
                workspaceId: context.workspaceId,
                biginId: reuse.externalId,
                previousPersonId: reuse.previousPersonId,
                newPersonId: personId,
                runId: state.runId,
                detectedAt: reuse.changedAt,
                before: reuse.before as unknown as Prisma.InputJsonValue,
                after: reuse.after as unknown as Prisma.InputJsonValue,
            },
        });
        await reuse.link(personId);
        return outcome;
    }

    /**
     * Bigin's stage in the default pipeline, by name (case-insensitive). "Closed Won"/"Closed Lost" with no
     * stage of that name are the pipeline's won and lost stages; any other stage it lacks is the first open
     * stage, and the raw stage is kept in the run report. Stages are never made by the importer.
     */
    private async resolveStage(tx: WorkspaceClient, state: RunState, raw: string | null): Promise<StageChoice> {
        if (!state.stages) {
            const pipeline = await tx.pipeline.findFirst({ where: { isDefault: true }, select: { id: true } });
            if (!pipeline) throw new ApiException(422, 'unprocessable', 'this workspace has no default pipeline');
            const stages = await tx.pipelineStage.findMany({
                where: { pipelineId: pipeline.id },
                orderBy: { position: 'asc' },
                select: { id: true, name: true, kind: true },
            });
            state.stages = stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind as StageKind }));
        }
        const stages = state.stages;
        const open = this.firstOpen(state);
        if (!raw) return { id: open.id, kind: 'open', unknown: false };
        const key = raw.trim().toLowerCase();
        const named = stages.find((s) => s.name.trim().toLowerCase() === key);
        if (named) return { id: named.id, kind: named.kind, unknown: false };
        const kind: StageKind | null = /\bwon\b/.test(key) ? 'won' : /\blost\b/.test(key) ? 'lost' : null;
        const closed = kind ? stages.find((s) => s.kind === kind) : undefined;
        if (closed) return { id: closed.id, kind: closed.kind, unknown: false };
        return { id: open.id, kind: 'open', unknown: true };
    }

    private firstOpen(state: RunState): { id: string } {
        const open = state.stages?.find((s) => s.kind === 'open');
        if (!open) throw new ApiException(422, 'unprocessable', 'the default pipeline has no open stage');
        return open;
    }

    /**
     * Owners who are not members here yet (#184's option, BIGIN-1): an account and a seat with the run's
     * role, made through the account service — outside the page's transaction, before it — so the page's
     * records are theirs. Nothing is mailed.
     */
    private async provisionOwners(state: RunState, records: BiginRecord[]): Promise<void> {
        const owners = new Map<string, string | null>();
        for (const record of records) {
            const email = ownerEmailOf(record);
            if (email && !owners.has(email)) owners.set(email, ownerNameOf(record));
        }
        for (const [email, name] of owners) {
            const seat = await this.rls.withWorkspace((tx) =>
                tx.workspaceMember.findFirst({ where: { user: { email } }, select: { id: true } }),
            );
            if (seat) continue;
            const made = await this.auth.provisionMember({
                workspaceId: state.context.workspaceId,
                email,
                displayName: name,
                roleId: state.membersRoleId!,
            });
            if (made.createdSeat) state.accountsCreated += 1;
        }
    }

    /** The module's cursors on the settings row: the records' and (at a pass's end) the deletions'. */
    private async saveModuleCursors(
        tx: WorkspaceClient,
        state: RunState,
        module: BiginImportObject,
        records: string | null,
        deleted: string | null | undefined,
    ): Promise<void> {
        const settings = await tx.biginImportSettings.findFirst({ select: { workspaceId: true, cursors: true } });
        if (!settings) return;
        const cursors = { ...stored<Record<string, string>>(settings.cursors) };
        if (records) cursors[module] = records;
        if (deleted) cursors[deletedKey(module)] = deleted;
        await tx.biginImportSettings.update({ where: { workspaceId: settings.workspaceId }, data: { cursors } });
    }

    private cancelRequested(runId: string): Promise<boolean> {
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.biginImportRun.findUnique({ where: { id: runId }, select: { cancelRequested: true } });
            return row?.cancelRequested === true;
        });
    }

    private saveProgress(tx: WorkspaceClient, state: RunState): Promise<unknown> {
        return tx.biginImportRun.update({
            where: { id: state.runId },
            data: {
                phase: state.phase ?? null,
                cursor: state.cursors as unknown as Prisma.InputJsonValue,
                report: state.report as unknown as Prisma.InputJsonValue,
                accountsCreated: state.accountsCreated,
            },
        });
    }

    private async finish(
        runId: string,
        status: 'succeeded' | 'failed' | 'cancelled',
        error?: string,
        state?: RunState,
    ): Promise<void> {
        await this.rls.withWorkspace(async (tx) => {
            const row = await tx.biginImportRun.update({
                where: { id: runId },
                data: {
                    status,
                    error: error ?? null,
                    finishedAt: new Date(),
                    phase: null,
                    ...(state
                        ? {
                              cursor: state.cursors as unknown as Prisma.InputJsonValue,
                              report: state.report as unknown as Prisma.InputJsonValue,
                              accountsCreated: state.accountsCreated,
                          }
                        : {}),
                },
            });
            await this.sync.recordOutcome(tx, row);
        });
    }
}

/** The person's name and address as BylineCRM has them: what a link without a snapshot is compared with. */
async function currentIdentity(tx: WorkspaceClient, personId: string): Promise<ContactIdentity> {
    const person = await tx.person.findUniqueOrThrow({
        where: { id: personId },
        select: { nameFirst: true, nameLast: true, emailPrimary: true },
    });
    return {
        name: [person.nameFirst, person.nameLast].filter((p) => p).join(' '),
        email: person.emailPrimary,
    };
}

const deletedKey = (module: BiginImportObject) => `${module}:deleted`;

async function trashed(tx: WorkspaceClient, type: CrossSourceType | 'note', id: string): Promise<boolean> {
    const where = { id };
    const select = { deletedAt: true } as const;
    const row =
        type === 'company'
            ? await tx.company.findUnique({ where, select })
            : type === 'person'
              ? await tx.person.findUnique({ where, select })
              : type === 'opportunity'
                ? await tx.opportunity.findUnique({ where, select })
                : await tx.note.findUnique({ where, select });
    return !row || row.deletedAt !== null;
}

/** A mapper's answer as the page carries it: a skip has no custom values. */
function asResult(
    mapped: { skip: string } | { input: unknown; custom: InferredCustom; ownerEmail: string | null },
): MapResult {
    return 'skip' in mapped ? { skip: mapped.skip, custom: {} } : mapped;
}

function skip(mapped: { note?: string }, reason: string): 'skipped' {
    mapped.note = reason;
    return 'skipped';
}

function reportEntry(report: BiginImportObjectReport[], object: BiginImportObject): BiginImportObjectReport {
    return report.find((r) => r.object === object)!;
}

function recordError(entry: BiginImportObjectReport, externalId: string, message: string): void {
    if (entry.errors.length < TWENTY_IMPORT_ERRORS_KEPT) entry.errors.push({ externalId, message });
}

function refusalText(error: HttpException): string {
    if (error instanceof ApiException && error.fieldErrors?.length) {
        return error.fieldErrors.map((f) => `${f.path}: ${f.message}`).join('; ');
    }
    return error.message;
}
