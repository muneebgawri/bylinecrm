import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { hashToken } from '../../auth/tokens';
import { RateLimiter } from '../../auth/rate-limiter.service';
import { ApiException, RateLimited } from '../../infra/errors/api-errors';
import { PrismaService } from '../../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../../infra/rls-prisma.service';
import { SecretBox } from '../../infra/secret-box';
import { membersByAddress } from '../../mail-sync/matching';
import { insidersFor, MeetingStore, type CopyKey, type CopyOrigin, type WriteScope } from '../meeting-store';
import type { SlotlineHookResult } from './responses';
import { parseSlotlineDelivery, type SlotlineDelivery } from './slotline-booking';
import {
    SLOTLINE_HOOK_FAILURE_LIMIT,
    SLOTLINE_HOOK_FAILURE_WINDOW_S,
    SLOTLINE_LEAD_SOURCE,
    slotlineHookRateKey,
} from './slotline.constants';

/** The 401 a delivery with a wrong or missing signature gets: nothing about why. */
class BadSignature extends ApiException {
    constructor() {
        super(401, 'unauthorized', 'the delivery is not signed with this hook’s secret');
    }
}

/**
 * Takes a Slotline webhook delivery (CAL-2). The URL's token names the workspace (read through the owner
 * client, as the tracking routes do: nothing else is known before it); the body must be signed with the
 * workspace's secret — checked over the raw bytes, in constant time — or nothing is read. A booking is then the
 * copy of its organiser's member in the meeting store, with the same rules as a Google Calendar meeting; a
 * cancellation or rejection calls the meeting off. A booking no member organised is counted and left: the CRM
 * cannot say whose KPI or lead it would be.
 *
 * Replays are harmless: storing a booking again changes nothing, and a cancelled meeting is cancelled once.
 */
@Injectable()
export class SlotlineHookService {
    private readonly logger = new Logger(SlotlineHookService.name);

    constructor(
        // The hook has no workspace until its token names one: the owner client reads that mapping only.
        private readonly ownerPrisma: PrismaService,
        private readonly rls: RlsPrismaService,
        private readonly secrets: SecretBox,
        private readonly meetings: MeetingStore,
        private readonly limiter: RateLimiter,
    ) {}

    async receive(
        token: string,
        rawBody: Buffer | undefined,
        signature: string | undefined,
        body: unknown,
        clientIp: string,
    ): Promise<SlotlineHookResult> {
        const settings = await this.ownerPrisma.slotlineSettings.findUnique({
            where: { hookTokenHash: hashToken(token) },
            select: { id: true, workspaceId: true, secretCiphertext: true },
        });
        if (!settings) {
            await this.refused(clientIp);
            throw new NotFoundException('not found');
        }
        const { workspaceId } = settings;
        if (!rawBody || !signed(rawBody, signature, this.secrets.open(settings.secretCiphertext))) {
            await this.record(workspaceId, 'bad_signature');
            await this.refused(clientIp);
            throw new BadSignature();
        }

        const delivery = parseSlotlineDelivery(body);
        const result = await this.ingest(settings, delivery);
        await this.record(workspaceId, result, delivery.kind === 'booking' ? delivery.organizer : undefined);
        return { result };
    }

    /**
     * What is done with a delivery once read — by the hook, and by the catch-up for a booking whose delivery
     * never arrived — so a booking is stored by one set of rules however it came, and reading it twice is
     * harmless.
     */
    async ingest(
        settings: { id: string; workspaceId: string },
        delivery: SlotlineDelivery,
    ): Promise<SlotlineHookResult['result']> {
        if (delivery.kind === 'ping' || delivery.kind === 'ignored') return delivery.kind;
        const { workspaceId } = settings;
        const scope: WriteScope = {
            workspaceId,
            context: { workspaceId, capabilities: new Set(), actor: { kind: 'sync', id: settings.id } },
        };
        if (delivery.kind === 'cancel') {
            // A cancellation needs no member: the booking's identity finds the meeting, so it still lands after
            // the organiser has left, or for a booking whose organiser was never matched (it then finds nothing).
            const key: CopyKey = { ...scope, source: 'slotline', mailboxId: null };
            await this.meetings.store(scope, (tx) =>
                this.meetings.cancel(tx, key, delivery.providerEventId, { identityKey: delivery.providerEventId }),
            );
            return 'cancelled';
        }

        const origin = await this.originFor(scope, delivery.organizer);
        if (!origin) {
            this.logger.log(`workspace ${workspaceId}: a Slotline booking organised by no member`);
            return 'unmatched';
        }
        await this.meetings.store(scope, async (tx) => {
            // A reschedule of a booking that had no iCalendar UID cannot be told from a new one but by the uid it
            // replaces: that one is called off, so the meeting is not counted twice.
            if (delivery.replaces) {
                await this.meetings.cancel(tx, origin, delivery.replaces, { identityKey: delivery.replaces });
            }
            await this.meetings.writeMeeting(tx, origin, delivery.meeting, {
                slotlineUid: delivery.uid,
                mayReopen: delivery.rescheduled,
            });
        });
        return 'stored';
    }

    /**
     * Counts a refused delivery (no such hook, or a wrong signature) against the caller's address, and answers
     * `429` once there are too many. Only refusals count: Slotline's own server sends every booking from one
     * address and never retries, so a burst of real bookings must never be throttled.
     */
    private async refused(clientIp: string): Promise<void> {
        const over = await this.limiter.hit(
            slotlineHookRateKey(clientIp),
            SLOTLINE_HOOK_FAILURE_LIMIT,
            SLOTLINE_HOOK_FAILURE_WINDOW_S,
        );
        if (over) throw new RateLimited('too many refused deliveries; try again later');
    }

    /**
     * The organiser's member: by sign-in address, else by a connected personal mailbox's address. A member who
     * has left is no one's KPI any more. With them, everything the store's rules need about the workspace.
     */
    private originFor(scope: WriteScope, organizer: string): Promise<CopyOrigin | null> {
        return this.rls.withWorkspace(scope.workspaceId, async (tx) => {
            const memberId = await memberFor(tx, organizer);
            if (!memberId) return null;
            const { insiders, blocklist } = await insidersFor(tx, { memberId, address: organizer });
            return {
                ...scope,
                source: 'slotline',
                memberId,
                mailboxId: null,
                ownerAddress: organizer,
                insiders,
                blocklist,
                leadSource: SLOTLINE_LEAD_SOURCE,
            };
        });
    }

    /** The hook's health on the settings row; `organizer` is counted only when the booking was unmatched. */
    private async record(workspaceId: string, result: string, organizer?: string): Promise<void> {
        const unmatched = result === 'unmatched' ? organizer : undefined;
        await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.slotlineSettings.updateMany({
                data: {
                    lastDeliveryAt: new Date(),
                    lastDeliveryResult: result,
                    ...(unmatched ? { unmatchedOrganizers: { increment: 1 }, lastUnmatchedOrganizer: unmatched } : {}),
                },
            }),
        );
    }
}

async function memberFor(tx: WorkspaceClient, organizer: string): Promise<string | null> {
    const bySignIn = (await membersByAddress(tx, [organizer])).get(organizer);
    const memberId =
        bySignIn ??
        (
            await tx.mailbox.findFirst({
                where: { email: organizer, purpose: 'personal', status: { not: 'disconnected' } },
                select: { ownerMemberId: true },
            })
        )?.ownerMemberId;
    if (!memberId) return null;
    const member = await tx.workspaceMember.findUnique({ where: { id: memberId }, select: { leftAt: true } });
    return member && !member.leftAt ? memberId : null;
}

/** Whether `signature` is the hex HMAC-SHA256 of the raw body with `secret` (constant-time). */
export function signed(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
    if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
