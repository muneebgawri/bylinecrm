import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
    TWENTY_IMPORT_OBJECTS,
    type TwentyImportMode,
    type TwentyImportOverview,
    type TwentyImportPreview,
    type TwentyImportRunView,
    type TwentyImportSettingsView,
} from '@bylinecrm/shared';
import { ENV, type Env } from '../config/env';
import { ApiException, StateConflict, UnknownReference } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { afterCommit } from '../infra/transaction-scope';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { assertWebhookUrl } from '../webhooks/url-guard';
import { countLinks } from './links';
import { TWENTY_API_KEY_SHOWN_CHARS, TWENTY_IMPORT_RUNS_SHOWN } from './twenty-import.constants';
import { readConnection, runView, settingsView } from './twenty-import.settings';
import { TwentyImportWorkers } from './twenty-import.workers';
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
    ) {
        this.allowPrivate = env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    }

    overview(): Promise<TwentyImportOverview> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const [settings, latest, counts] = await Promise.all([
                tx.twentyImportSettings.findFirst(),
                tx.twentyImportRun.findFirst({ orderBy: { queuedAt: 'desc' } }),
                Promise.all(
                    TWENTY_IMPORT_OBJECTS.map(async (object) => ({ object, count: await countLinks(tx, object) })),
                ),
            ]);
            return { settings: settingsView(settings), latestRun: latest ? runView(latest) : null, linked: counts };
        });
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
        return { checkedAt: new Date().toISOString(), objects };
    }

    /**
     * Queues a run: the connection must exist and Twenty must accept its key now (one read, so a
     * dead key fails here, at the person, rather than in the worker). `changes` reads from the
     * last successful run's start; with none, it reads everything. One run at a time per workspace.
     */
    async start(mode: TwentyImportMode): Promise<TwentyImportRunView> {
        const context = this.current();
        const connection = await this.rls.withWorkspace(
            async (tx) => (await readConnection(tx, this.secrets))?.connection ?? null,
        );
        if (!connection) throw noConnection();
        await this.probe(connection);
        const row = await this.rls.withWorkspace(async (tx) => {
            const last = await tx.twentyImportRun.findFirst({
                where: { status: 'succeeded', startedAt: { not: null } },
                orderBy: { startedAt: 'desc' },
                select: { startedAt: true },
            });
            try {
                const created = await tx.twentyImportRun.create({
                    data: {
                        workspaceId: context.workspaceId,
                        mode,
                        since: mode === 'changes' ? (last?.startedAt ?? null) : null,
                        startedById: context.memberId ?? null,
                    },
                });
                afterCommit('TwentyImportService.start', () => {
                    void this.workers.enqueue({ workspaceId: context.workspaceId, runId: created.id });
                });
                return created;
            } catch (error) {
                if (uniqueViolation(error)) throw new StateConflict('an import is already queued or running');
                throw error;
            }
        });
        return runView(row);
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
