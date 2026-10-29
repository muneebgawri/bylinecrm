import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { hashToken } from '../auth/tokens';
import { RateLimiter } from '../auth/rate-limiter.service';
import { ApiException, RateLimited } from '../infra/errors/api-errors';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import {
    NEWSWIREOS_DELIVERY_SEEN_S,
    NEWSWIREOS_HOOK_FAILURE_LIMIT,
    NEWSWIREOS_HOOK_FAILURE_WINDOW_S,
    newswireosDeliveryKey,
    newswireosHookRateKey,
} from './invoices.constants';
import { InvoicesService, type PaymentStateChange } from './invoices.service';
import { NewswireosPaymentsService } from './newswireos-payments.service';
import { NewswireosTimelineService, parseTimeline } from './newswireos-timeline.service';
import type { NewswireosHookResult } from './responses';

const TYPES: readonly PaymentStateChange['type'][] = ['payment.refunded', 'payment.disputed', 'payment.verified'];

/**
 * Takes a NewswireOS payment-state delivery (INV-1): a refund or chargeback takes back the invoices on that
 * payment (`invoice.invalidated`); finance verifying one in NewswireOS settles an invoice waiting for it. The URL's
 * token names the workspace (read through the owner client, as Slotline's hook does); the raw body must be signed
 * with the workspace's secret, checked in constant time, or nothing is read. Replays change nothing. The same hook
 * takes NewswireOS's client activity for the timeline (PNW-766, `NewswireosTimelineService`); anything else is
 * acknowledged and dropped.
 */
@Injectable()
export class NewswireosHookService {
    constructor(
        // The hook has no workspace until its token names one: the owner client reads that mapping only.
        private readonly ownerPrisma: PrismaService,
        private readonly rls: RlsPrismaService,
        private readonly secrets: SecretBox,
        private readonly invoices: InvoicesService,
        private readonly limiter: RateLimiter,
        private readonly redis: RedisService,
        private readonly timeline: NewswireosTimelineService,
        private readonly payments: NewswireosPaymentsService,
    ) {}

    async receive(
        token: string,
        rawBody: Buffer | undefined,
        signature: string | undefined,
        body: unknown,
        clientIp: string,
        webhookId?: string,
    ): Promise<NewswireosHookResult> {
        const settings = await this.ownerPrisma.newswireosSettings.findUnique({
            where: { hookTokenHash: hashToken(token) },
            select: { workspaceId: true, secretCiphertext: true },
        });
        if (!settings) {
            await this.refused(clientIp);
            throw new NotFoundException('not found');
        }
        const { workspaceId } = settings;
        if (settings.secretCiphertext === null) {
            await this.record(workspaceId, 'no_secret');
            throw new ApiException(401, 'unauthorized', 'this hook’s secret has not been set in the CRM yet');
        }
        if (!rawBody || !signed(rawBody, signature, this.secrets.open(settings.secretCiphertext))) {
            await this.record(workspaceId, 'bad_signature');
            await this.refused(clientIp);
            throw new ApiException(401, 'unauthorized', 'the delivery is not signed with this hook’s secret');
        }
        // PNW-766: client activity for the timeline, on the same hook and secret; de-duplicated on its stored row.
        const timeline = parseTimeline(body, webhookId);
        if (timeline !== null) {
            const result = timeline === 'ignored' ? timeline : await this.timeline.apply(workspaceId, timeline);
            // INV-2: a paid invoice also goes on its deal. Asked on a redelivery too: it is idempotent on the
            // invoice number, so a payment a failed delivery left undone is done when NewswireOS retries.
            if (timeline !== 'ignored') await this.payments.received(workspaceId, timeline);
            await this.record(workspaceId, result);
            return { result };
        }
        const delivery = parse(body);
        if (delivery === 'ignored') {
            await this.record(workspaceId, delivery);
            return { result: delivery };
        }
        // NewswireOS retries until it gets a 2xx: a delivery already applied is acknowledged, not applied twice.
        const seen = delivery.id ? newswireosDeliveryKey(workspaceId, delivery.id) : null;
        if (seen) {
            await this.redis.ensureReady();
            if (await this.redis.exists(seen)) {
                await this.record(workspaceId, 'duplicate');
                return { result: 'duplicate' };
            }
        }
        const changed = await this.invoices.applyPaymentState(workspaceId, delivery);
        // Remembered once applied: a delivery that failed half-way is applied again on NewswireOS's retry.
        if (seen) await this.redis.set(seen, '1', 'EX', NEWSWIREOS_DELIVERY_SEEN_S);
        const result = changed > 0 ? 'applied' : 'unmatched';
        await this.record(workspaceId, result);
        return { result };
    }

    private async refused(clientIp: string): Promise<void> {
        const over = await this.limiter.hit(
            newswireosHookRateKey(clientIp),
            NEWSWIREOS_HOOK_FAILURE_LIMIT,
            NEWSWIREOS_HOOK_FAILURE_WINDOW_S,
        );
        if (over) throw new RateLimited('too many refused deliveries; try again later');
    }

    private async record(workspaceId: string, result: string): Promise<void> {
        await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.newswireosSettings.updateMany({ data: { lastDeliveryAt: new Date(), lastDeliveryResult: result } }),
        );
    }
}

/** Whether `signature` is the hex HMAC-SHA256 of `raw` with `secret`. Exported for the suite. */
export function signed(raw: Buffer, signature: string | undefined, secret: string): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', secret).update(raw).digest();
    const given = Buffer.from(signature.trim().replace(/^sha256=/, ''), 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A delivery, read defensively. Exported for its spec. */
export function parse(body: unknown): (PaymentStateChange & { id: string | null }) | 'ignored' {
    const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const type = TYPES.find((t) => t === o['event_type']);
    const data = o['data'] && typeof o['data'] === 'object' ? (o['data'] as Record<string, unknown>) : null;
    if (!type || !data || typeof data['gateway'] !== 'string') return 'ignored';
    const references = [data['reference'], ...(Array.isArray(data['references']) ? data['references'] : [])]
        .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
        .map((r) => r.trim().slice(0, 500));
    if (references.length === 0) return 'ignored';
    return {
        id: typeof o['id'] === 'string' && o['id'] !== '' ? o['id'].slice(0, 200) : null,
        type,
        gateway: data['gateway'],
        reasonCode:
            typeof data['reason_code'] === 'string' && data['reason_code'] !== ''
                ? data['reason_code'].slice(0, 100)
                : null,
        references: [...new Set(references)].slice(0, 20),
        refundedCents:
            typeof data['refunded_amount_cents'] === 'number' && Number.isSafeInteger(data['refunded_amount_cents'])
                ? Math.max(0, data['refunded_amount_cents'])
                : null,
        detail: {
            id: typeof o['id'] === 'string' ? o['id'] : null,
            occurredAt: typeof o['occurred_at'] === 'string' ? o['occurred_at'] : null,
            amountCents: typeof data['amount_cents'] === 'number' ? data['amount_cents'] : null,
            refundedAmountCents:
                typeof data['refunded_amount_cents'] === 'number' ? data['refunded_amount_cents'] : null,
            currency: typeof data['currency'] === 'string' ? data['currency'] : null,
            reasonCode: typeof data['reason_code'] === 'string' ? data['reason_code'] : null,
        },
    };
}
