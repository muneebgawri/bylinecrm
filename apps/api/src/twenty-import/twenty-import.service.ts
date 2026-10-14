import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
    type TwentyImportCreateMembers,
    type TwentyImportMissingView,
    type TwentyImportObject,
    TWENTY_IMPORT_OBJECTS,
    type TwentyImportMode,
    type TwentyImportOverview,
    type TwentyImportPreview,
    type TwentyImportRunView,
    type TwentyImportSettingsView,
    type TwentyImportSyncView,
    type TwentySyncInterval,
} from '@bylinecrm/shared';
import { ENV, type Env } from '../config/env';
import { ApiException, UnknownReference } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { afterCommit } from '../infra/transaction-scope';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { assertWebhookUrl } from '../webhooks/url-guard';
import { personName } from '../records/summaries';
import type { Page } from '../records/list-query';
import { countLinks } from './links';
import { memberEmailOf } from './mappers';
import { TWENTY_API_KEY_SHOWN_CHARS, TWENTY_IMPORT_RUNS_SHOWN } from './twenty-import.constants';
import { queueRun } from './twenty-import.runs';
import { readConnection, runView, settingsView } from './twenty-import.settings';
import { TwentyImportWorkers } from './twenty-import.workers';
import { TwentySyncService } from './twenty-sync.service';
import { TwentyApiError, TwentyHttp } from './twenty.http';
import { TWENTY_PORT, type TwentyApi, type TwentyConnection } from './twenty.port';

/**
 * The importer's API (P4-4, doc 48 §11): the connection (the key sealed at rest, shown by its
 * last characters only), a preview that reads Twenty's counts now, and the runs — queued here,
 * driven by the worker (`TwentyImportRunner`). One run at a time per workspace. The base URL is
 * held to the same rule as a webhook target: a public host, never the API's own network (the
 * development flag that admits a local receiver admits a local Twenty too).
 */
@Injectable()
export class TwentyImportService {
    private readonly allowPrivate: boolean;

    constructor(
        @Inject(ENV) env: Env,
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        @Inject(TWENTY_PORT) private readonly twenty: TwentyApi,
        private readonly workers: TwentyImportWorkers,
        private readonly sync: TwentySyncService,
    ) {
        this.allowPrivate = env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    }

    async overview(): Promise<TwentyImportOverview> {
        const { workspaceId } = this.current();
        const { settings, latest, counts } = await this.rls.withWorkspace(async (tx) => {
            const [settings, latest, counts] = await Promise.all([
                tx.twentyImportSettings.findFirst(),
                tx.twentyImportRun.findFirst({ orderBy: { queuedAt: 'desc' } }),
                Promise.all(
                    TWENTY_IMPORT_OBJECTS.map(async (object) => ({ object, count: await countLinks(tx, object) })),
                ),
            ]);
            return { settings, latest, counts };
        });
        return {
            settings: settingsView(settings),
            latestRun: latest ? runView(latest) : null,
            linked: counts,
            sync: await this.syncView(workspaceId, settings),
        };
    }

    /**
     * The automatic sync's interval (#185): a setting on the connection — there is nothing to sync
     * without one — put into effect as the workspace's job scheduler once the row is committed.
     * Turning it on is a fresh start: the failure streak and a cutover are cleared.
     */
    async putSync(interval: TwentySyncInterval): Promise<TwentyImportSyncView> {
        const { workspaceId } = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            const existing = await tx.twentyImportSettings.findFirst();
            if (!existing) throw noConnection();
            const updated = await tx.twentyImportSettings.update({
                where: { workspaceId },
                data:
                    interval === 'off'
                        ? { syncInterval: interval }
                        : { syncInterval: interval, syncFailures: 0, syncLastError: null, cutoverAt: null },
            });
            afterCommit('TwentyImportService.putSync', () => {
                void this.workers.schedule(workspaceId, interval);
            });
            return updated;
        });
        return this.syncView(workspaceId, row);
    }

    /** Stop syncing (cutover, #185): off for good — the schedule goes and the moment is recorded. */
    async cutover(): Promise<TwentyImportSyncView> {
        const { workspaceId } = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            const existing = await tx.twentyImportSettings.findFirst();
            if (!existing) throw noConnection();
            const updated = await tx.twentyImportSettings.update({
                where: { workspaceId },
                data: { syncInterval: 'off', cutoverAt: new Date() },
            });
            afterCommit('TwentyImportService.cutover', () => {
                void this.workers.schedule(workspaceId, 'off');
            });
            return updated;
        });
        return this.syncView(workspaceId, row);
    }

    async putSettings(input: { baseUrl: string; apiKey: string }): Promise<TwentyImportSettingsView> {
        const { workspaceId, memberId } = this.current();
        const url = await assertWebhookUrl(input.baseUrl, { allowPrivate: this.allowPrivate }).catch(
            (error: unknown) => {
                throw new UnknownReference('baseUrl', error instanceof Error ? error.message : 'url is not valid');
            },
        );
        const baseUrl = url.toString().replace(/\/+$/, '');
        const data = {
            baseUrl,
            apiKeyCiphertext: this.secrets.seal(input.apiKey),
            apiKeyLast4: input.apiKey.slice(-TWENTY_API_KEY_SHOWN_CHARS),
            configuredById: memberId ?? null,
        };
        const row = await this.rls.withWorkspace((tx) =>
            tx.twentyImportSettings.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data }),
        );
        return settingsView(row);
    }

    async removeSettings(): Promise<void> {
        const { workspaceId } = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const existing = await tx.twentyImportSettings.findFirst();
            if (!existing) throw new NotFoundException('no Twenty connection is configured');
            await tx.twentyImportSettings.delete({ where: { workspaceId } });
        });
    }

    /** Twenty's count per object, read now (outside any transaction), beside what is mapped here. */
    async preview(): Promise<TwentyImportPreview> {
        this.current();
        const { connection, linked } = await this.rls.withWorkspace(async (tx) => {
            const stored = await readConnection(tx, this.secrets);
            if (!stored) throw noConnection();
            const counts = await Promise.all(TWENTY_IMPORT_OBJECTS.map((object) => countLinks(tx, object)));
            return { connection: stored.connection, linked: counts };
        });
        const objects: TwentyImportPreview['objects'] = [];
        for (const [index, object] of TWENTY_IMPORT_OBJECTS.entries()) {
            try {
                objects.push({
                    object,
                    remote: await this.twenty.count(connection, object),
                    linked: linked[index]!,
                    error: null,
                });
            } catch (error) {
                if (error instanceof TwentyApiError && error.status !== 401 && error.status !== 403) {
                    objects.push({ object, remote: null, linked: linked[index]!, error: error.message });
                    continue;
                }
                throw keyRefused(error);
            }
        }
        return {
            checkedAt: new Date().toISOString(),
            objects,
            accountsToCreate: await this.accountsToCreate(connection),
        };
    }

    /**
     * What the accounts option would create (#184): Twenty's members with a usable address who have
     * no seat here, held or left. Twenty is read outside any transaction; null when it could not be.
     */
    private async accountsToCreate(connection: TwentyConnection): Promise<number | null> {
        const emails = new Set<string>();
        let cursor: string | null = null;
        try {
            for (;;) {
                const page = await this.twenty.list(connection, 'workspaceMembers', { cursor, depth: 0 });
                for (const record of page.records) {
                    const email = memberEmailOf(record);
                    if (email) emails.add(email);
                }
                if (!page.hasNextPage || page.records.length === 0 || !page.endCursor) break;
                cursor = page.endCursor;
            }
        } catch (error) {
            if (error instanceof TwentyApiError) return null;
            throw error;
        }
        if (emails.size === 0) return 0;
        const seated = await this.rls.withWorkspace((tx) =>
            tx.workspaceMember.findMany({
                where: { user: { email: { in: [...emails] } } },
                select: { user: { select: { email: true } } },
            }),
        );
        for (const seat of seated) emails.delete(seat.user.email);
        return emails.size;
    }

    /**
     * Queues a run: the connection must exist and Twenty must accept its key now (one read, so a
     * dead key fails here, at the person, rather than in the worker). `changes` reads from the
     * last successful run's start; with none, it reads everything. One run at a time per workspace.
     * The accounts option (#184) goes with the run and is saved as the workspace's choice.
     */
    async start(mode: TwentyImportMode, createMembers?: TwentyImportCreateMembers): Promise<TwentyImportRunView> {
        const context = this.current();
        const connection = await this.rls.withWorkspace(
            async (tx) => (await readConnection(tx, this.secrets))?.connection ?? null,
        );
        if (!connection) throw noConnection();
        await this.probe(connection);
        const row = await this.rls.withWorkspace(async (tx) => {
            // Looked up inside the workspace (#184): the foreign key alone would accept another workspace's role.
            if (createMembers) {
                const role = await tx.role.findUnique({ where: { id: createMembers.roleId }, select: { id: true } });
                if (!role) throw new UnknownReference('roleId', 'no such role in this workspace');
            }
            // The option as chosen is the workspace's choice from now on: what the screen offers next
            // time, and what a scheduled run (#185) uses. A reconcile pass offers no option and changes none.
            if (mode !== 'reconcile') {
                await tx.twentyImportSettings.update({
                    where: { workspaceId: context.workspaceId },
                    data: { createMembersRoleId: createMembers?.roleId ?? null },
                });
            }
            const created = await queueRun(tx, {
                workspaceId: context.workspaceId,
                mode,
                startedById: context.memberId ?? null,
                scheduled: false,
                createMembersRoleId: createMembers?.roleId ?? null,
            });
            afterCommit('TwentyImportService.start', () => {
                void this.workers.enqueue({ workspaceId: context.workspaceId, runId: created.id });
            });
            return created;
        });
        return runView(row);
    }

    /**
     * The records a reconcile pass flagged as missing in Twenty (#156), oldest flag first, with the
     * local record's name for the review list. Nothing here is deleted on its own: a person decides,
     * record by record, and the next run that sees a record in Twenty again clears its flag.
     */
    async missing(query: {
        object?: TwentyImportObject | undefined;
        limit: number;
        cursor?: string | undefined;
    }): Promise<Page<TwentyImportMissingView>> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const after = query.cursor ? decodeMissingCursor(query.cursor) : null;
            const rows = await tx.twentyImportLink.findMany({
                where: {
                    missingSince: { not: null },
                    ...(query.object ? { object: query.object } : {}),
                    ...(after
                        ? {
                              OR: [
                                  { object: { gt: after.object } },
                                  { object: after.object, externalId: { gt: after.externalId } },
                              ],
                          }
                        : {}),
                },
                orderBy: [{ object: 'asc' }, { externalId: 'asc' }],
                take: query.limit + 1,
            });
            const hasMore = rows.length > query.limit;
            const items = hasMore ? rows.slice(0, query.limit) : rows;
            const names = await localNames(tx, items);
            const last = items[items.length - 1];
            return {
                items: items.map((row) => ({
                    object: row.object as TwentyImportObject,
                    externalId: row.externalId,
                    localType: row.localType,
                    localId: row.localId,
                    name: names.get(`${row.localType}:${row.localId}`) ?? row.label,
                    missingSince: row.missingSince!.toISOString(),
                })),
                nextCursor:
                    hasMore && last
                        ? Buffer.from(`${last.object}\n${last.externalId}`, 'utf8').toString('base64url')
                        : null,
            };
        });
    }

    runs(): Promise<TwentyImportRunView[]> {
        this.current();
        return this.rls.withWorkspace(async (tx) =>
            (await tx.twentyImportRun.findMany({ orderBy: { queuedAt: 'desc' }, take: TWENTY_IMPORT_RUNS_SHOWN })).map(
                runView,
            ),
        );
    }

    run(runId: string): Promise<TwentyImportRunView> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.twentyImportRun.findUnique({ where: { id: runId } });
            if (!row) throw notFound();
            return runView(row);
        });
    }

    /** Asks a queued or running run to stop; the worker stops after the page it is on. */
    cancel(runId: string): Promise<TwentyImportRunView> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.twentyImportRun.findUnique({ where: { id: runId } });
            if (!row) throw notFound();
            if (row.status !== 'queued' && row.status !== 'running') return runView(row);
            return runView(await tx.twentyImportRun.update({ where: { id: runId }, data: { cancelRequested: true } }));
        });
    }

    /** One cheap read, so a key Twenty refuses is refused here and now. */
    private async probe(connection: TwentyConnection): Promise<void> {
        try {
            await this.twenty.count(connection, 'people');
        } catch (error) {
            if (error instanceof TwentyApiError && error.status !== 401 && error.status !== 403) {
                throw new ApiException(422, 'unprocessable', error.message);
            }
            throw keyRefused(error);
        }
    }

    /** The sync view, with the scheduler's next firing read from Redis — outside any transaction. */
    private async syncView(
        workspaceId: string,
        settings: Parameters<TwentySyncService['view']>[0],
    ): Promise<TwentyImportSyncView> {
        const next = settings && settings.syncInterval !== 'off' ? await this.workers.nextSyncAt(workspaceId) : null;
        return this.sync.view(settings, next);
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('TwentyImportService is used inside a workspace scope');
        return context;
    }
}

function noConnection(): ApiException {
    return new ApiException(422, 'unprocessable', 'connect a Twenty workspace first', [
        { path: 'apiKey', message: 'no Twenty connection is configured' },
    ]);
}

function keyRefused(error: unknown): ApiException {
    const message = error instanceof TwentyApiError ? error.message : `Twenty could not be read: ${String(error)}`;
    return new ApiException(422, 'unprocessable', message, [{ path: 'apiKey', message }]);
}

/** The one place the HTTP adapter is made: the module binds it to the port; tests bind a fake Twenty. */
export function twentyHttp(): TwentyApi {
    return new TwentyHttp();
}

function notFound(): NotFoundException {
    return new NotFoundException('import run not found');
}

function decodeMissingCursor(cursor: string): { object: string; externalId: string } {
    const [object, externalId] = Buffer.from(cursor, 'base64url').toString('utf8').split('\n');
    if (!object || externalId === undefined) throw new ApiException(400, 'validation.failed', 'cursor is not valid');
    return { object, externalId };
}

/** The names of the local records a page of flagged links maps to, one query per record type. */
async function localNames(
    tx: WorkspaceClient,
    rows: readonly { localType: string; localId: string }[],
): Promise<Map<string, string>> {
    const ids = (type: string) => [...new Set(rows.filter((r) => r.localType === type).map((r) => r.localId))];
    const names = new Map<string, string>();
    const companies = ids('company');
    if (companies.length) {
        for (const c of await tx.company.findMany({
            where: { id: { in: companies } },
            select: { id: true, name: true },
        }))
            names.set(`company:${c.id}`, c.name);
    }
    const people = ids('person');
    if (people.length) {
        for (const p of await tx.person.findMany({
            where: { id: { in: people } },
            select: { id: true, nameFirst: true, nameLast: true, emails: true },
        }))
            names.set(
                `person:${p.id}`,
                personName(p.nameFirst, p.nameLast, (p.emails as { primary?: string | null } | null)?.primary),
            );
    }
    const deals = ids('opportunity');
    if (deals.length) {
        for (const d of await tx.opportunity.findMany({
            where: { id: { in: deals } },
            select: { id: true, name: true },
        }))
            names.set(`opportunity:${d.id}`, d.name);
    }
    const notes = ids('note');
    if (notes.length) {
        for (const n of await tx.note.findMany({ where: { id: { in: notes } }, select: { id: true, title: true } }))
            if (n.title) names.set(`note:${n.id}`, n.title);
    }
    const tasks = ids('task');
    if (tasks.length) {
        for (const t of await tx.task.findMany({ where: { id: { in: tasks } }, select: { id: true, title: true } }))
            names.set(`task:${t.id}`, t.title);
    }
    return names;
}
