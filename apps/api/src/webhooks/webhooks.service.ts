import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import {
    DOMAIN_EVENT_TYPES,
    WEBHOOK_EVENT_WILDCARD,
    WEBHOOK_PING_EVENT,
    type WebhookDeliveryStatus,
    type WebhookEnvelope,
    objectOfEvent,
} from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { ENV, type Env } from '../config/env';
import type { DeliveredEvent } from '../events/outbox-consumer';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext } from '../infra/workspace-context';
import { type Page, paginate } from '../records/list-query';
import { WebhookSender, type SendOutcome } from './sender';
import { generateWebhookSecret, secretPrefixOf } from './signature';
import { assertWebhookUrl } from './url-guard';
import {
    WEBHOOK_AUTO_DISABLE_AFTER_DEAD,
    WEBHOOK_MAX_ATTEMPTS,
    WEBHOOK_QUEUE,
    WEBHOOK_ROTATION_GRACE_S,
    backoffDelayMs,
} from './webhooks.constants';
import type { WebhookEndpointView, WebhookDeliveryView, WebhookEventView } from './responses';
export type { WebhookEndpointView, WebhookDeliveryView, WebhookEventView } from './responses';

/** What the queue carries: enough to find the row; everything else is read fresh at attempt time. */
export interface DeliveryJob {
    deliveryId: string;
    workspaceId: string;
    endpointId: string;
}

/** How one attempt ended, for the worker to decide whether the queue retries. */
export interface AttemptOutcome {
    ok: boolean;
    /** True when nothing further will be tried: success, dead, or a delivery no longer deliverable. */
    final: boolean;
    statusCode: number | null;
    /** When not final: how long until the next attempt — the same wait written to `nextAttemptAt`. */
    retryDelayMs: number | null;
}

type EndpointRow = Prisma.WebhookEndpointGetPayload<object>;
type DeliveryRow = Prisma.WebhookDeliveryGetPayload<object>;

/**
 * Endpoints, deliveries, and the two moments a delivery is made: enqueued when an event is
 * published (`enqueueForEvent`, from the subscriber) and attempted by the worker (`attempt`).
 * A test send and a redelivery go through the same `attempt`, so there is one definition of
 * what a delivery is and one record of how it went.
 */
@Injectable()
export class WebhooksService {
    private readonly logger = new Logger(WebhooksService.name);
    private readonly allowPrivate: boolean;

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        private readonly sender: WebhookSender,
        @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue<DeliveryJob>,
        @Inject(ENV) env: Env,
    ) {
        this.allowPrivate = env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
        // A queue without an error listener turns a Redis hiccup into an unhandled 'error'.
        this.queue.on('error', (error) => this.logger.error(`queue ${WEBHOOK_QUEUE}: ${error.message}`));
    }

    // ── Endpoints ────────────────────────────────────────────────────────────────────────────

    /** The catalogue, for a UI's subscription picker. `ping` is not here: it is only ever a test. */
    events(): WebhookEventView[] {
        return DOMAIN_EVENT_TYPES.map((name) => ({ name, object: objectOfEvent(name) }));
    }

    list(): Promise<WebhookEndpointView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.webhookEndpoint.findMany({
                where: { deletedAt: null },
                orderBy: { createdAt: 'asc' },
            });
            return rows.map(endpointView);
        });
    }

    get(id: string): Promise<WebhookEndpointView> {
        return this.rls.withWorkspace(async (tx) => endpointView(await this.live(tx, id)));
    }

    /** The response carries the secret once; afterwards only its prefix is shown. */
    async create(input: {
        url: string;
        description: string;
        events: string[];
        enabled: boolean;
        createdById: string;
    }): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
        const url = (await assertWebhookUrl(input.url, { allowPrivate: this.allowPrivate })).toString();
        const secret = generateWebhookSecret();
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.webhookEndpoint.create({
                data: {
                    workspaceId: this.current().workspaceId,
                    url,
                    description: input.description,
                    events: input.events,
                    enabled: input.enabled,
                    secretCiphertext: this.secrets.seal(secret),
                    secretPrefix: secretPrefixOf(secret),
                    createdById: input.createdById,
                },
            });
            return { endpoint: endpointView(row), secret };
        });
    }

    async update(
        id: string,
        patch: {
            url?: string | undefined;
            description?: string | undefined;
            events?: string[] | undefined;
            enabled?: boolean | undefined;
        },
    ): Promise<WebhookEndpointView> {
        const url = patch.url
            ? (await assertWebhookUrl(patch.url, { allowPrivate: this.allowPrivate })).toString()
            : undefined;
        return this.rls.withWorkspace(async (tx) => {
            await this.live(tx, id);
            const row = await tx.webhookEndpoint.update({
                where: { id },
                data: {
                    ...(url !== undefined ? { url } : {}),
                    ...(patch.description !== undefined ? { description: patch.description } : {}),
                    ...(patch.events !== undefined ? { events: patch.events } : {}),
                    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
                    // Switching an endpoint back on is a person's decision: the system's reason and
                    // its count are cleared so the next failures start a fresh run.
                    ...(patch.enabled === true ? { disabledReason: null, consecutiveFailures: 0 } : {}),
                },
            });
            return endpointView(row);
        });
    }

    /** Retires the endpoint; its delivery log stays readable through the deliveries route. */
    remove(id: string): Promise<void> {
        return this.rls.withWorkspace(async (tx) => {
            await this.live(tx, id);
            await tx.webhookEndpoint.update({ where: { id }, data: { deletedAt: new Date(), enabled: false } });
        });
    }

    /**
     * A new secret, shown once. The previous one keeps signing — deliveries carry both signatures —
     * until the grace window closes, so a receiver can switch over without a gap.
     */
    rotate(id: string): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
        const secret = generateWebhookSecret();
        return this.rls.withWorkspace(async (tx) => {
            const current = await this.live(tx, id);
            const row = await tx.webhookEndpoint.update({
                where: { id },
                data: {
                    secretCiphertext: this.secrets.seal(secret),
                    secretPrefix: secretPrefixOf(secret),
                    previousSecretCiphertext: current.secretCiphertext,
                    previousSecretExpiresAt: new Date(Date.now() + WEBHOOK_ROTATION_GRACE_S * 1000),
                },
            });
            return { endpoint: endpointView(row), secret };
        });
    }

    /** One `ping`, sent now and recorded like any delivery; the caller sees the receiver's answer. */
    async test(id: string): Promise<{ delivery: WebhookDeliveryView; statusCode: number | null; ok: boolean }> {
        const workspaceId = this.current().workspaceId;
        const deliveryId = await this.rls.withWorkspace(async (tx) => {
            const endpoint = await this.live(tx, id);
            const row = await tx.webhookDelivery.create({
                data: {
                    id: randomUUID(),
                    workspaceId,
                    endpointId: endpoint.id,
                    eventId: randomUUID(),
                    eventName: WEBHOOK_PING_EVENT,
                    payload: {} as Prisma.InputJsonValue,
                },
            });
            await tx.webhookDelivery.update({
                where: { id: row.id },
                data: {
                    payload: envelope(row.id, WEBHOOK_PING_EVENT, new Date(), workspaceId, {
                        ping: true,
                    }) as unknown as Prisma.InputJsonValue,
                },
            });
            return row.id;
        });
        const outcome = await this.attempt({ deliveryId, workspaceId, endpointId: id }, { singleShot: true });
        const delivery = await this.rls.withWorkspace(workspaceId, async (tx) =>
            deliveryView(await tx.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } })),
        );
        return { delivery, statusCode: outcome.statusCode, ok: outcome.ok };
    }

    // ── Deliveries ───────────────────────────────────────────────────────────────────────────

    deliveries(
        endpointId: string,
        query: { status?: WebhookDeliveryStatus | undefined; cursor?: string | undefined; limit: number },
    ): Promise<Page<WebhookDeliveryView>> {
        return this.rls.withWorkspace(async (tx) => {
            await this.anyEndpoint(tx, endpointId);
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.webhookDelivery.findMany({
                    where: { endpointId, ...(query.status ? { status: query.status } : {}) },
                    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                    ...args,
                }),
            );
            return { items: page.items.map(deliveryView), nextCursor: page.nextCursor };
        });
    }

    /** A fresh delivery of the same event to the same endpoint, through the queue like any other. */
    async redeliver(endpointId: string, deliveryId: string): Promise<WebhookDeliveryView> {
        const workspaceId = this.current().workspaceId;
        const row = await this.rls.withWorkspace(async (tx) => {
            const endpoint = await this.live(tx, endpointId);
            const original = await tx.webhookDelivery.findFirst({ where: { id: deliveryId, endpointId: endpoint.id } });
            if (!original) throw new NotFoundException('delivery not found');
            const payload = original.payload as unknown as WebhookEnvelope;
            const id = randomUUID();
            return tx.webhookDelivery.create({
                data: {
                    id,
                    workspaceId,
                    endpointId: endpoint.id,
                    eventId: original.eventId,
                    redeliveryOfId: original.id,
                    eventName: original.eventName,
                    payload: { ...payload, id } as unknown as Prisma.InputJsonValue,
                },
            });
        });
        await this.enqueue({ deliveryId: row.id, workspaceId, endpointId });
        return deliveryView(row);
    }

    // ── The two moments ──────────────────────────────────────────────────────────────────────

    /**
     * Called by the subscriber for every recorded event: one delivery row and one job per enabled
     * endpoint whose subscription names the event. Runs in the event's workspace with no request
     * context (the relay is not a request). Idempotent on the outbox event (P1-6): an automatic
     * delivery is unique per (event, endpoint), so a redelivered event adds no row, and only rows still
     * `pending` are enqueued — under their own id, which the queue never holds twice. Returns how
     * many deliveries the event has.
     */
    async enqueueForEvent({ id: eventId, event }: DeliveredEvent): Promise<number> {
        const jobs = await this.rls.withWorkspace(event.workspaceId, async (tx) => {
            const endpoints = await tx.webhookEndpoint.findMany({
                where: { deletedAt: null, enabled: true, events: { hasSome: [WEBHOOK_EVENT_WILDCARD, event.type] } },
                select: { id: true },
            });
            if (endpoints.length === 0) return [];
            await tx.webhookDelivery.createMany({
                data: endpoints.map((endpoint) => {
                    const id = randomUUID();
                    return {
                        id,
                        workspaceId: event.workspaceId,
                        endpointId: endpoint.id,
                        eventId,
                        eventName: event.type,
                        payload: envelope(
                            id,
                            event.type,
                            new Date(event.occurredAt),
                            event.workspaceId,
                            event,
                        ) as unknown as Prisma.InputJsonValue,
                    };
                }),
                skipDuplicates: true,
            });
            const rows = await tx.webhookDelivery.findMany({
                where: { eventId, redeliveryOfId: null, status: 'pending' },
                select: { id: true, endpointId: true },
            });
            return rows.map((row): DeliveryJob => ({
                deliveryId: row.id,
                workspaceId: event.workspaceId,
                endpointId: row.endpointId,
            }));
        });
        for (const job of jobs) await this.enqueue(job);
        return jobs.length;
    }

    /**
     * One attempt at one delivery, by the worker or by a test send (`singleShot`: one try,
     * recorded, never dead and never counted against the endpoint). Reads the row and the endpoint
     * fresh, signs with every valid secret, sends, and records the result — success, a wait for the
     * next attempt, or death and (after enough deaths) the endpoint's automatic disable.
     *
     * **The row counts the attempts, not the queue.** This attempt is `row.attempts + 1`, and the
     * wait before the next is computed from it. A job the sweep re-enqueued starts with BullMQ's own
     * count at zero; reading the row means it neither restarts the schedule nor exceeds the limit.
     */
    async attempt(job: DeliveryJob, options: { singleShot?: boolean } = {}): Promise<AttemptOutcome> {
        const prepared = await this.rls.withWorkspace(job.workspaceId, async (tx) => {
            const delivery = await tx.webhookDelivery.findUnique({
                where: { id: job.deliveryId },
                include: { endpoint: true },
            });
            if (!delivery) return { skip: 'delivery not found' as const };
            if (delivery.status === 'succeeded' || delivery.status === 'dead')
                return { skip: `already ${delivery.status}` as const };
            const endpoint = delivery.endpoint;
            if (endpoint.deletedAt || !endpoint.enabled) {
                await tx.webhookDelivery.update({
                    where: { id: delivery.id },
                    data: { status: 'dead', lastError: 'endpoint is disabled or deleted', nextAttemptAt: null },
                });
                return { skip: 'endpoint disabled' as const };
            }
            const attempt = delivery.attempts + 1;
            await tx.webhookDelivery.update({
                where: { id: delivery.id },
                data: { status: 'delivering', attempts: attempt, attemptStartedAt: new Date() },
            });
            return { delivery, endpoint, attempt, secrets: this.validSecrets(endpoint) };
        });
        if ('skip' in prepared) return { ok: false, final: true, statusCode: null, retryDelayMs: null };
        const attempt = prepared.attempt;

        let outcome: SendOutcome;
        try {
            await assertWebhookUrl(prepared.endpoint.url, { allowPrivate: this.allowPrivate });
            outcome = await this.sender.send({
                url: prepared.endpoint.url,
                secrets: prepared.secrets,
                envelope: prepared.delivery.payload as unknown as WebhookEnvelope,
            });
        } catch (error) {
            outcome = { ok: false, statusCode: null, error: error instanceof Error ? error.message : String(error) };
        }

        const final = outcome.ok || options.singleShot === true || attempt >= WEBHOOK_MAX_ATTEMPTS;
        const retryDelayMs = final ? null : backoffDelayMs(attempt);
        await this.rls.withWorkspace(job.workspaceId, async (tx) => {
            if (outcome.ok) {
                await tx.webhookDelivery.update({
                    where: { id: job.deliveryId },
                    data: {
                        status: 'succeeded',
                        deliveredAt: new Date(),
                        lastStatusCode: outcome.statusCode,
                        lastError: null,
                        nextAttemptAt: null,
                    },
                });
                if (!options.singleShot) {
                    await tx.webhookEndpoint.update({
                        where: { id: job.endpointId },
                        data: { consecutiveFailures: 0 },
                    });
                }
                return;
            }
            if (options.singleShot) {
                await tx.webhookDelivery.update({
                    where: { id: job.deliveryId },
                    data: {
                        status: 'failed',
                        lastStatusCode: outcome.statusCode,
                        lastError: outcome.error,
                        nextAttemptAt: null,
                    },
                });
                return;
            }
            if (!final) {
                await tx.webhookDelivery.update({
                    where: { id: job.deliveryId },
                    data: {
                        status: 'failed',
                        lastStatusCode: outcome.statusCode,
                        lastError: outcome.error,
                        nextAttemptAt: new Date(Date.now() + (retryDelayMs ?? 0)),
                    },
                });
                return;
            }
            await tx.webhookDelivery.update({
                where: { id: job.deliveryId },
                data: {
                    status: 'dead',
                    lastStatusCode: outcome.statusCode,
                    lastError: outcome.error,
                    nextAttemptAt: null,
                },
            });
            const endpoint = await tx.webhookEndpoint.update({
                where: { id: job.endpointId },
                data: { consecutiveFailures: { increment: 1 } },
            });
            if (endpoint.enabled && endpoint.consecutiveFailures >= WEBHOOK_AUTO_DISABLE_AFTER_DEAD) {
                await tx.webhookEndpoint.update({
                    where: { id: job.endpointId },
                    data: {
                        enabled: false,
                        disabledReason: `switched off after ${endpoint.consecutiveFailures} consecutive failed deliveries; the last error was: ${outcome.error ?? 'unknown'}`,
                    },
                });
                this.logger.warn(
                    `webhook endpoint ${job.endpointId} disabled after ${endpoint.consecutiveFailures} dead deliveries`,
                );
            }
        });
        return { ok: outcome.ok, final, statusCode: outcome.statusCode, retryDelayMs };
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────────────────

    /**
     * The one way a delivery gets onto the queue — from an event, a redelivery or the sweep. The
     * job's id is the delivery's, so adding a delivery that already has a live job is a no-op: the
     * queue, not the caller, guarantees one job per delivery.
     */
    enqueue(job: DeliveryJob, delayMs = 0): Promise<unknown> {
        return this.queue.add('deliver', job, {
            jobId: job.deliveryId,
            delay: delayMs,
            removeOnComplete: true,
            removeOnFail: true,
        });
    }

    /** The secrets that sign right now: the current one, and the previous while its window is open. */
    private validSecrets(endpoint: EndpointRow): string[] {
        const secrets = [this.secrets.open(endpoint.secretCiphertext)];
        if (
            endpoint.previousSecretCiphertext &&
            endpoint.previousSecretExpiresAt &&
            endpoint.previousSecretExpiresAt > new Date()
        ) {
            secrets.push(this.secrets.open(endpoint.previousSecretCiphertext));
        }
        return secrets;
    }

    private current() {
        const context = this.context.get();
        if (!context) throw new UnprocessableEntityException('no workspace in context');
        return context;
    }

    /** An endpoint that is not retired, or `404`. */
    private async live(tx: WorkspaceClient, id: string): Promise<EndpointRow> {
        const row = await tx.webhookEndpoint.findFirst({ where: { id, deletedAt: null } });
        if (!row) throw new NotFoundException('webhook endpoint not found');
        return row;
    }

    /** Any endpoint, retired or not: its delivery log outlives it. */
    private async anyEndpoint(tx: WorkspaceClient, id: string): Promise<EndpointRow> {
        const row = await tx.webhookEndpoint.findUnique({ where: { id } });
        if (!row) throw new NotFoundException('webhook endpoint not found');
        return row;
    }
}

/** The body as sent: the one shape, built in one place. */
function envelope(id: string, event: string, occurredAt: Date, workspaceId: string, data: unknown): WebhookEnvelope {
    return { id, event, occurredAt: occurredAt.toISOString(), workspaceId, data };
}

function endpointView(row: EndpointRow): WebhookEndpointView {
    return {
        id: row.id,
        url: row.url,
        description: row.description,
        events: row.events,
        enabled: row.enabled,
        disabledReason: row.disabledReason,
        consecutiveFailures: row.consecutiveFailures,
        secretPrefix: row.secretPrefix,
        previousSecretExpiresAt: row.previousSecretExpiresAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function deliveryView(row: DeliveryRow): WebhookDeliveryView {
    return {
        id: row.id,
        endpointId: row.endpointId,
        eventId: row.eventId,
        eventName: row.eventName,
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
        lastStatusCode: row.lastStatusCode,
        lastError: row.lastError,
        createdAt: row.createdAt,
        deliveredAt: row.deliveredAt,
    };
}
