import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { hashToken } from '../auth/tokens';
import { RateLimiter } from '../auth/rate-limiter.service';
import { ApiException, RateLimited } from '../infra/errors/api-errors';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import {
    NEWSWIREOS_HOOK_FAILURE_LIMIT,
    NEWSWIREOS_HOOK_FAILURE_WINDOW_S,
    newswireosHookRateKey,
} from './invoices.constants';
import { InvoicesService, type PaymentStateChange } from './invoices.service';
import type { NewswireosHookResult } from './responses';

const TYPES: readonly PaymentStateChange['type'][] = ['payment.refunded', 'payment.disputed', 'payment.verified'];

/**
 * Takes a NewswireOS payment-state delivery (INV-1): a refund or chargeback takes back the invoices on that
 * payment (`invoice.invalidated`); finance verifying one in NewswireOS settles an invoice waiting for it. The URL's
 * token names the workspace (read through the owner client, as Slotline's hook does); the raw body must be signed
 * with the workspace's secret, checked in constant time, or nothing is read. Replays change nothing.
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
    ) {}

    async receive(
        token: string,
        rawBody: Buffer | undefined,
        signature: string | undefined,
        body: unknown,
        clientIp: string,
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
        if (!rawBody || !signed(rawBody, signature, this.secrets.open(settings.secretCiphertext))) {
            await this.record(workspaceId, 'bad_signature');
            await this.refused(clientIp);
            throw new ApiException(401, 'unauthorized', 'the delivery is not signed with this hook’s secret');
        }
        const delivery = parse(body);
        if (delivery === 'ping' || delivery === 'ignored') {
            await this.record(workspaceId, delivery);
            return { result: delivery };
        }
        const changed = await this.invoices.applyPaymentState(workspaceId, delivery);
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
export function parse(body: unknown): PaymentStateChange | 'ping' | 'ignored' {
    const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    if (o['type'] === 'ping') return 'ping';
    const type = TYPES.find((t) => t === o['type']);
    const data = o['data'] && typeof o['data'] === 'object' ? (o['data'] as Record<string, unknown>) : null;
    if (!type || !data || typeof data['gateway'] !== 'string') return 'ignored';
    const references = [data['reference'], ...(Array.isArray(data['references']) ? data['references'] : [])]
        .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
        .map((r) => r.trim().slice(0, 500));
    if (references.length === 0) return 'ignored';
    return {
        type,
        gateway: data['gateway'],
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
