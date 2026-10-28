import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma.service';
import { RlsPrismaService } from '../../infra/rls-prisma.service';
import { SecretBox } from '../../infra/secret-box';
import { SLOTLINE_ADMIN_API_PORT, type SlotlineAdminApiPort } from './slotline-api.port';
import { parseSlotlineDelivery, slotlineDeliveryFor } from './slotline-booking';
import { SlotlineHookService } from './slotline-hook.service';
import { SLOTLINE_CATCH_UP_FIRST_LOOKBACK_MS, SLOTLINE_CATCH_UP_OVERLAP_MS } from './slotline.constants';

/**
 * The Slotline catch-up: Slotline sends each delivery once and never retries, so a booking made while the CRM
 * was down would be lost. A workspace that gives the key of Slotline's admin route has every booking created or
 * changed since its last pass read again, and each goes through the hook's own ingest — one set of rules, so a
 * booking the hook already stored is left as it is, and a cancellation or reschedule lands as its delivery
 * would have. A pass keeps how far it got (Slotline's clock) only once it has read every page; one that fails
 * is recorded, and the next starts from the same place.
 */
@Injectable()
export class SlotlineCatchUpService {
    private readonly logger = new Logger(SlotlineCatchUpService.name);

    constructor(
        // A tick is no tenant's: the owner client lists which workspaces catch up, and nothing else.
        private readonly ownerPrisma: PrismaService,
        private readonly rls: RlsPrismaService,
        private readonly secrets: SecretBox,
        private readonly hook: SlotlineHookService,
        @Inject(SLOTLINE_ADMIN_API_PORT) private readonly api: SlotlineAdminApiPort,
    ) {}

    async workspaces(): Promise<string[]> {
        const rows = await this.ownerPrisma.slotlineSettings.findMany({
            where: { catchUpKeyCiphertext: { not: null } },
            select: { workspaceId: true },
        });
        return rows.map((row) => row.workspaceId);
    }

    /** One pass for the workspace: how many bookings were read, or null when it has no catch-up. */
    async catchUp(workspaceId: string): Promise<number | null> {
        const settings = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.slotlineSettings.findFirst({
                select: {
                    id: true,
                    workspaceId: true,
                    baseUrl: true,
                    catchUpKeyCiphertext: true,
                    catchUpThrough: true,
                },
            }),
        );
        if (!settings?.catchUpKeyCiphertext) return null;
        const key = this.secrets.open(settings.catchUpKeyCiphertext);
        const since = settings.catchUpThrough
            ? new Date(settings.catchUpThrough.getTime() - SLOTLINE_CATCH_UP_OVERLAP_MS)
            : new Date(Date.now() - SLOTLINE_CATCH_UP_FIRST_LOOKBACK_MS);

        const counts = new Map<string, number>();
        let read = 0;
        let until: string | undefined;
        let cursor: string | undefined;
        try {
            do {
                const page = await this.api.bookingChanges(settings.baseUrl, key, { since, until, cursor });
                until = page.until;
                for (const booking of page.bookings) {
                    read += 1;
                    const body = slotlineDeliveryFor(booking);
                    const result = body ? await this.hook.ingest(settings, parseSlotlineDelivery(body)) : 'skipped';
                    counts.set(result, (counts.get(result) ?? 0) + 1);
                }
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`workspace ${workspaceId}: Slotline catch-up failed: ${message}`);
            await this.record(workspaceId, { lastCatchUpResult: `failed: ${message}`.slice(0, 500) });
            throw error;
        }
        const summary = [...counts].map(([result, n]) => `${n} ${result}`).join(', ');
        await this.record(workspaceId, {
            catchUpThrough: new Date(until!),
            lastCatchUpResult: `ok${summary ? `: ${summary}` : ''}`,
        });
        return read;
    }

    private async record(
        workspaceId: string,
        data: { catchUpThrough?: Date; lastCatchUpResult: string },
    ): Promise<void> {
        await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.slotlineSettings.updateMany({ data: { ...data, lastCatchUpAt: new Date() } }),
        );
    }
}
