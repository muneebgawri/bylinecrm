import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { hashToken } from '../../auth/tokens';
import { ApiException } from '../../infra/errors/api-errors';
import { PrismaService } from '../../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../../infra/rls-prisma.service';
import { SecretBox } from '../../infra/secret-box';
import type { WorkspaceRunContext } from '../../infra/workspace-context';
import { entriesFor } from '../../mail-sync/blocklist-rule';
import { membersByAddress } from '../../mail-sync/matching';
import { MeetingStore, type CopyOrigin } from '../meeting-store';
import type { SlotlineHookResult } from './responses';
import { parseSlotlineDelivery } from './slotline-booking';
import { SLOTLINE_LEAD_SOURCE } from './slotline.constants';

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
    ) {}

    async receive(
        token: string,
        rawBody: Buffer | undefined,
        signature: string | undefined,
        body: unknown,
    ): Promise<SlotlineHookResult> {
        const settings = await this.ownerPrisma.slotlineSettings.findUnique({
            where: { hookTokenHash: hashToken(token) },
            select: { id: true, workspaceId: true, secretCiphertext: true },
        });
        if (!settings) throw new NotFoundException('not found');
        const { workspaceId } = settings;
        if (!rawBody || !signed(rawBody, signature, this.secrets.open(settings.secretCiphertext))) {
            await this.record(workspaceId, 'bad_signature');
            throw new BadSignature();
        }

        const delivery = parseSlotlineDelivery(body);
        if (delivery.kind === 'ping' || delivery.kind === 'ignored') {
            await this.record(workspaceId, delivery.kind);
            return { result: delivery.kind };
        }

        const origin = await this.originFor(workspaceId, settings.id, delivery.organizer);
        if (!origin) {
            await this.record(workspaceId, 'unmatched', delivery.organizer);
            this.logger.log(`workspace ${workspaceId}: a Slotline booking organised by no member`);
            return { result: 'unmatched' };
        }

        if (delivery.kind === 'cancel') {
            await this.meetings.store(origin, (tx) =>
                this.meetings.cancel(tx, origin, delivery.providerEventId, { identityKey: delivery.providerEventId }),
            );
            await this.record(workspaceId, 'cancelled');
            return { result: 'cancelled' };
        }

        await this.meetings.store(origin, async (tx) => {
            // A reschedule of a booking that had no iCalendar UID cannot be told from a new one but by the uid it
            // replaces: that one is called off, so the meeting is not counted twice.
            if (delivery.replaces) {
                await this.meetings.cancel(tx, origin, delivery.replaces, { identityKey: delivery.replaces });
            }
            await this.meetings.writeMeeting(tx, origin, delivery.meeting, { slotlineUid: delivery.uid });
        });
        await this.record(workspaceId, 'stored');
        return { result: 'stored' };
    }

    /**
     * The organiser's member: by sign-in address, else by a connected personal mailbox's address. A member who
     * has left is no one's KPI any more. With them, everything the store's rules need about the workspace.
     */
    private originFor(workspaceId: string, settingsId: string, organizer: string): Promise<CopyOrigin | null> {
        return this.rls.withWorkspace(workspaceId, async (tx) => {
            const memberId = await memberFor(tx, organizer);
            if (!memberId) return null;
            const [members, mailboxes, entries] = await Promise.all([
                tx.workspaceMember.findMany({ select: { user: { select: { email: true } } } }),
                tx.mailbox.findMany({ select: { email: true } }),
                tx.blocklistEntry.findMany({
                    where: { OR: [{ memberId: null }, { memberId }] },
                    select: { value: true, memberId: true },
                }),
            ]);
            const context: WorkspaceRunContext = {
                workspaceId,
                capabilities: new Set(),
                actor: { kind: 'sync', id: settingsId },
            };
            return {
                source: 'slotline',
                workspaceId,
                memberId,
                mailboxId: null,
                ownerAddress: organizer,
                insiders: new Set([
                    organizer,
                    ...members.map((m) => m.user.email.toLowerCase()),
                    ...mailboxes.map((m) => m.email.toLowerCase()),
                ]),
                // The blocklist that applies to the member's own mail applies to their bookings.
                blocklist: entriesFor({ email: organizer, ownerMemberId: memberId, purpose: 'personal' }, entries),
                leadSource: SLOTLINE_LEAD_SOURCE,
                context,
            };
        });
    }

    private async record(workspaceId: string, result: string, unmatched?: string): Promise<void> {
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
