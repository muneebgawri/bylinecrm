import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
    BIGIN_IMPORT_OBJECTS,
    type BiginContactReuseView,
    type BiginImportCreateMembers,
    type BiginImportMissingView,
    type BiginImportMode,
    type BiginImportObject,
    type BiginImportOverview,
    type BiginImportPreview,
    type BiginImportRunView,
    type BiginImportSettingsView,
    type BiginImportSyncView,
    type TwentySyncInterval,
} from '@bylinecrm/shared';
import type { BiginImportSettings } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { ApiException, UnknownReference } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { afterCommit } from '../infra/transaction-scope';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import type { Page } from '../records/list-query';
import { stored } from '../records/references';
import { personName } from '../records/summaries';
import { assertWebhookUrl } from '../webhooks/url-guard';
import { BIGIN_IMPORT_RUNS_SHOWN, BIGIN_SECRET_SHOWN_CHARS } from './bigin-import.constants';
import { biginRunView, biginSettingsView, queueBiginRun, readBiginConnection } from './bigin-import.settings';
import { BiginImportWorkers } from './bigin-import.workers';
import { BiginSyncService } from './bigin-sync.service';
import { BiginApiError, BiginHttp } from './bigin.http';
import { BIGIN_PORT, type BiginApi, type BiginConnection } from './bigin.port';
import { countBiginLinks } from './links';

export interface BiginSettingsInput {
    accountsUrl: string;
    apiUrl: string;
    clientId: string;
    /** Absent on an update that keeps the stored secret. */
    clientSecret?: string | undefined;
    refreshToken?: string | undefined;
    /** A self client's one-time grant code, traded for the refresh token on save. */
    grantCode?: string | undefined;
}

/**
 * The Bigin importer's API (BIGIN-1): the connection (the client secret and refresh token sealed at
 * rest, never returned), a preview that reads Bigin's counts now, the runs — queued here, driven by
 * the worker — the automatic sync, and what Bigin deleted, for review. One run at a time per
 * workspace. The two Zoho URLs are held to the webhook target rule (a public host; the development
 * flag that admits a local receiver admits a local fake of Bigin).
 */
@Injectable()
export class BiginImportService {
    private readonly allowPrivate: boolean;

    constructor(
        @Inject(ENV) env: Env,
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        @Inject(BIGIN_PORT) private readonly bigin: BiginApi,
        private readonly workers: BiginImportWorkers,
        private readonly sync: BiginSyncService,
    ) {
        this.allowPrivate = env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    }

    async overview(): Promise<BiginImportOverview> {
        const { workspaceId } = this.current();
        const { settings, latest, counts } = await this.rls.withWorkspace(async (tx) => {
            const [settings, latest, counts] = await Promise.all([
                tx.biginImportSettings.findFirst(),
                tx.biginImportRun.findFirst({ orderBy: { queuedAt: 'desc' } }),
                Promise.all(
                    BIGIN_IMPORT_OBJECTS.map(async (object) => ({ object, count: await countBiginLinks(tx, object) })),
                ),
            ]);
            return { settings, latest, counts };
        });
        const cursors = settings ? stored<Record<string, string>>(settings.cursors) : {};
        return {
            settings: biginSettingsView(settings),
            latestRun: latest ? biginRunView(latest) : null,
            linked: counts,
            cursors: BIGIN_IMPORT_OBJECTS.map((object) => ({ object, since: cursors[object] ?? null })),
            sync: await this.syncView(workspaceId, settings),
        };
    }

    async putSettings(input: BiginSettingsInput): Promise<BiginImportSettingsView> {
        const { workspaceId, memberId } = this.current();
        const accountsUrl = await this.checkedUrl('accountsUrl', input.accountsUrl);
        const apiUrl = await this.checkedUrl('apiUrl', input.apiUrl);
        // A grant code is traded for the refresh token here, outside any transaction (a network call), with
        // the secret given or, on an update that leaves it out, the stored one.
        if (input.grantCode && !input.refreshToken) {
            const clientSecret =
                input.clientSecret ??
                (await this.rls.withWorkspace(
                    async (tx) => (await readBiginConnection(tx, this.secrets))?.connection.clientSecret,
                ));
            if (!clientSecret) {
                throw new ApiException(422, 'unprocessable', 'a new connection needs its client secret', [
                    { path: 'clientSecret', message: 'required' },
                ]);
            }
            try {
                const refreshToken = await this.bigin.exchangeGrantCode(
                    { accountsUrl, clientId: input.clientId, clientSecret },
                    input.grantCode,
                );
                input = { ...input, refreshToken };
            } catch (error) {
                if (!(error instanceof BiginApiError)) throw error;
                throw new ApiException(422, 'unprocessable', error.message, [
                    { path: 'grantCode', message: error.message },
                ]);
            }
        }
        const row = await this.rls.withWorkspace(async (tx) => {
            const existing = await tx.biginImportSettings.findFirst();
            if (!existing && (!input.clientSecret || !input.refreshToken)) {
                throw new ApiException(
                    422,
                    'unprocessable',
                    'a new connection needs its secret, and a grant code or refresh token',
                    [
                        ...(input.clientSecret ? [] : [{ path: 'clientSecret', message: 'required' }]),
                        ...(input.refreshToken ? [] : [{ path: 'refreshToken', message: 'required' }]),
                    ],
                );
            }
            const data = {
                accountsUrl,
                apiUrl,
                clientId: input.clientId,
                configuredById: memberId ?? null,
                ...(input.clientSecret ? { clientSecretCiphertext: this.secrets.seal(input.clientSecret) } : {}),
                ...(input.refreshToken
                    ? {
                          refreshTokenCiphertext: this.secrets.seal(input.refreshToken),
                          refreshTokenLast4: input.refreshToken.slice(-BIGIN_SECRET_SHOWN_CHARS),
                      }
                    : {}),
            };
            if (existing) return tx.biginImportSettings.update({ where: { workspaceId }, data });
            return tx.biginImportSettings.create({
                data: {
                    workspaceId,
                    ...data,
                    clientSecretCiphertext: this.secrets.seal(input.clientSecret!),
                    refreshTokenCiphertext: this.secrets.seal(input.refreshToken!),
                    refreshTokenLast4: input.refreshToken!.slice(-BIGIN_SECRET_SHOWN_CHARS),
                },
            });
        });
        return biginSettingsView(row);
    }

    async removeSettings(): Promise<void> {
        const { workspaceId } = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const existing = await tx.biginImportSettings.findFirst();
            if (!existing) throw new NotFoundException('no Bigin connection is configured');
            await tx.biginImportSettings.delete({ where: { workspaceId } });
            afterCommit('BiginImportService.removeSettings', () => {
                void this.workers.schedule(workspaceId, 'off');
            });
        });
    }

    /** Bigin's count per module, read now (outside any transaction), beside what is mapped here. */
    async preview(): Promise<BiginImportPreview> {
        this.current();
        const { connection, linked } = await this.rls.withWorkspace(async (tx) => {
            const stored = await readBiginConnection(tx, this.secrets);
            if (!stored) throw noConnection();
            const counts = await Promise.all(BIGIN_IMPORT_OBJECTS.map((object) => countBiginLinks(tx, object)));
            return { connection: stored.connection, linked: counts };
        });
        const objects: BiginImportPreview['objects'] = [];
        for (const [index, object] of BIGIN_IMPORT_OBJECTS.entries()) {
            try {
                objects.push({
                    object,
                    remote: await this.bigin.count(connection, object),
                    linked: linked[index]!,
                    error: null,
                });
            } catch (error) {
                if (error instanceof BiginApiError && error.status !== 401 && error.status !== 403) {
                    objects.push({ object, remote: null, linked: linked[index]!, error: error.message });
                    continue;
                }
                throw refused(error);
            }
        }
        return { checkedAt: new Date().toISOString(), objects };
    }

    /**
     * Queues a run: the connection must exist and Zoho must accept it now (one read, so dead credentials
     * fail here, at the person, rather than in the worker). The accounts option goes with the run and is
     * saved as the workspace's choice, which a scheduled run uses.
     */
    async start(mode: BiginImportMode, createMembers?: BiginImportCreateMembers): Promise<BiginImportRunView> {
        const context = this.current();
        const connection = await this.rls.withWorkspace(
            async (tx) => (await readBiginConnection(tx, this.secrets))?.connection ?? null,
        );
        if (!connection) throw noConnection();
        await this.probe(connection);
        const row = await this.rls.withWorkspace(async (tx) => {
            if (createMembers) {
                const role = await tx.role.findUnique({ where: { id: createMembers.roleId }, select: { id: true } });
                if (!role) throw new UnknownReference('roleId', 'no such role in this workspace');
            }
            await tx.biginImportSettings.update({
                where: { workspaceId: context.workspaceId },
                data: { createMembersRoleId: createMembers?.roleId ?? null },
            });
            const created = await queueBiginRun(tx, {
                workspaceId: context.workspaceId,
                mode,
                startedById: context.memberId ?? null,
                scheduled: false,
                createMembersRoleId: createMembers?.roleId ?? null,
            });
            afterCommit('BiginImportService.start', () => {
                void this.workers.enqueue({ workspaceId: context.workspaceId, runId: created.id });
            });
            return created;
        });
        return biginRunView(row);
    }

    runs(): Promise<BiginImportRunView[]> {
        this.current();
        return this.rls.withWorkspace(async (tx) =>
            (await tx.biginImportRun.findMany({ orderBy: { queuedAt: 'desc' }, take: BIGIN_IMPORT_RUNS_SHOWN })).map(
                biginRunView,
            ),
        );
    }

    run(runId: string): Promise<BiginImportRunView> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.biginImportRun.findUnique({ where: { id: runId } });
            if (!row) throw notFound();
            return biginRunView(row);
        });
    }

    cancel(runId: string): Promise<BiginImportRunView> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.biginImportRun.findUnique({ where: { id: runId } });
            if (!row) throw notFound();
            if (row.status !== 'queued' && row.status !== 'running') return biginRunView(row);
            return biginRunView(
                await tx.biginImportRun.update({ where: { id: runId }, data: { cancelRequested: true } }),
            );
        });
    }

    /** Records Bigin deleted that are mapped here, oldest flag first, with the local record's name, for review. */
    async missing(query: {
        object?: BiginImportObject | undefined;
        limit: number;
        cursor?: string | undefined;
    }): Promise<Page<BiginImportMissingView>> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const after = query.cursor ? decodeCursor(query.cursor) : null;
            const rows = await tx.biginImportLink.findMany({
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
                    object: row.object as BiginImportObject,
                    externalId: row.externalId,
                    localType: row.localType,
                    localId: row.localId,
                    name: names.get(`${row.localType}:${row.localId}`) ?? null,
                    missingSince: row.missingSince!.toISOString(),
                })),
                nextCursor:
                    hasMore && last
                        ? Buffer.from(`${last.object}\n${last.externalId}`, 'utf8').toString('base64url')
                        : null,
            };
        });
    }

    /** Bigin Contacts reused for another person (BIGIN-1), newest first: who each held before and after. */
    async reuses(query: { limit: number; cursor?: string | undefined }): Promise<Page<BiginContactReuseView>> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.biginContactReuse.findMany({
                orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
                take: query.limit + 1,
                ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
            });
            const hasMore = rows.length > query.limit;
            const items = hasMore ? rows.slice(0, query.limit) : rows;
            return {
                items: items.map((row) => ({
                    id: row.id,
                    biginId: row.biginId,
                    previousPersonId: row.previousPersonId,
                    newPersonId: row.newPersonId,
                    detectedAt: row.detectedAt.toISOString(),
                    before: row.before as BiginContactReuseView['before'],
                    after: row.after as BiginContactReuseView['after'],
                })),
                nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
            };
        });
    }

    async putSync(interval: TwentySyncInterval): Promise<BiginImportSyncView> {
        const { workspaceId } = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            if (!(await tx.biginImportSettings.findFirst())) throw noConnection();
            const updated = await tx.biginImportSettings.update({
                where: { workspaceId },
                data:
                    interval === 'off'
                        ? { syncInterval: interval }
                        : { syncInterval: interval, syncFailures: 0, syncLastError: null, cutoverAt: null },
            });
            afterCommit('BiginImportService.putSync', () => {
                void this.workers.schedule(workspaceId, interval);
            });
            return updated;
        });
        return this.syncView(workspaceId, row);
    }

    async cutover(): Promise<BiginImportSyncView> {
        const { workspaceId } = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            if (!(await tx.biginImportSettings.findFirst())) throw noConnection();
            const updated = await tx.biginImportSettings.update({
                where: { workspaceId },
                data: { syncInterval: 'off', cutoverAt: new Date() },
            });
            afterCommit('BiginImportService.cutover', () => {
                void this.workers.schedule(workspaceId, 'off');
            });
            return updated;
        });
        return this.syncView(workspaceId, row);
    }

    private async checkedUrl(path: string, value: string): Promise<string> {
        const url = await assertWebhookUrl(value, { allowPrivate: this.allowPrivate }).catch((error: unknown) => {
            throw new UnknownReference(path, error instanceof Error ? error.message : 'url is not valid');
        });
        return url.toString().replace(/\/+$/, '');
    }

    private async probe(connection: BiginConnection): Promise<void> {
        try {
            await this.bigin.list(connection, 'Contacts', { since: new Date().toISOString(), page: 1 });
        } catch (error) {
            if (error instanceof BiginApiError && error.status !== 401 && error.status !== 403) {
                throw new ApiException(422, 'unprocessable', error.message);
            }
            throw refused(error);
        }
    }

    private async syncView(workspaceId: string, settings: BiginImportSettings | null): Promise<BiginImportSyncView> {
        const next = settings && settings.syncInterval !== 'off' ? await this.workers.nextSyncAt(workspaceId) : null;
        return this.sync.view(settings, next);
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('BiginImportService is used inside a workspace scope');
        return context;
    }
}

function noConnection(): ApiException {
    return new ApiException(422, 'unprocessable', 'connect Bigin first', [
        { path: 'refreshToken', message: 'no Bigin connection is configured' },
    ]);
}

function refused(error: unknown): ApiException {
    const message = error instanceof BiginApiError ? error.message : `Bigin could not be read: ${String(error)}`;
    return new ApiException(422, 'unprocessable', message, [{ path: 'refreshToken', message }]);
}

function notFound(): NotFoundException {
    return new NotFoundException('import run not found');
}

/** The one place the HTTP adapter is made: the module binds it to the port; tests bind a fake Bigin. */
export function biginHttp(): BiginApi {
    return new BiginHttp();
}

function decodeCursor(cursor: string): { object: string; externalId: string } {
    const [object, externalId] = Buffer.from(cursor, 'base64url').toString('utf8').split('\n');
    if (!object || externalId === undefined) throw new ApiException(400, 'validation.failed', 'cursor is not valid');
    return { object, externalId };
}

async function localNames(
    tx: WorkspaceClient,
    rows: readonly { localType: string; localId: string }[],
): Promise<Map<string, string>> {
    const ids = (type: string) => [...new Set(rows.filter((r) => r.localType === type).map((r) => r.localId))];
    const names = new Map<string, string>();
    for (const c of await tx.company.findMany({
        where: { id: { in: ids('company') } },
        select: { id: true, name: true },
    }))
        names.set(`company:${c.id}`, c.name);
    for (const p of await tx.person.findMany({
        where: { id: { in: ids('person') } },
        select: { id: true, nameFirst: true, nameLast: true, emails: true },
    }))
        names.set(
            `person:${p.id}`,
            personName(p.nameFirst, p.nameLast, (p.emails as { primary?: string | null } | null)?.primary),
        );
    for (const d of await tx.opportunity.findMany({
        where: { id: { in: ids('opportunity') } },
        select: { id: true, name: true },
    }))
        names.set(`opportunity:${d.id}`, d.name);
    for (const n of await tx.note.findMany({ where: { id: { in: ids('note') } }, select: { id: true, title: true } }))
        if (n.title) names.set(`note:${n.id}`, n.title);
    return names;
}
