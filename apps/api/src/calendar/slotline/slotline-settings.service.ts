import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { hashToken } from '../../auth/tokens';
import { ENV, type Env } from '../../config/env';
import { ApiException } from '../../infra/errors/api-errors';
import { RlsPrismaService } from '../../infra/rls-prisma.service';
import { SecretBox } from '../../infra/secret-box';
import { WorkspaceContext } from '../../infra/workspace-context';
import { randomToken } from '../../mail-accounts/oauth-flow';
import type { SlotlineSettingsView } from './responses';
import { SLOTLINE_BOOKING_TRIGGERS, SLOTLINE_CANCEL_TRIGGERS, SLOTLINE_HOOK_PATH } from './slotline.constants';

type SettingsRow = Prisma.SlotlineSettingsGetPayload<object>;

/**
 * The workspace's Slotline booking site (CAL-2), an admin's to set: its address, and the secret the
 * webhook in Slotline signs with. The hook's URL is made here once (a new one on `rotate`), so a leaked URL
 * can be replaced without touching the secret, and the other way round.
 */
@Injectable()
export class SlotlineSettingsService {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
    ) {}

    get(): Promise<SlotlineSettingsView> {
        return this.rls.withWorkspace(async (tx) => this.view(await tx.slotlineSettings.findFirst()));
    }

    async put(input: { baseUrl: string; secret?: string | undefined }): Promise<SlotlineSettingsView> {
        const context = this.context.get()!;
        if (!context.memberId) {
            throw new ApiException(403, 'forbidden', 'Slotline is set up by a member signed in, not by an API key');
        }
        const baseUrl = new URL(input.baseUrl).origin;
        return this.rls.withWorkspace(async (tx) => {
            const existing = await tx.slotlineSettings.findFirst();
            if (!existing && !input.secret) {
                throw new ApiException(400, 'validation.failed', 'the webhook’s secret is needed the first time');
            }
            const secret = input.secret ? { secretCiphertext: this.secrets.seal(input.secret) } : {};
            if (existing) {
                return this.view(
                    await tx.slotlineSettings.update({
                        where: { id: existing.id },
                        data: { baseUrl, ...secret, configuredById: context.memberId! },
                    }),
                );
            }
            const token = randomToken();
            return this.view(
                await tx.slotlineSettings.create({
                    data: {
                        workspaceId: context.workspaceId,
                        baseUrl,
                        secretCiphertext: this.secrets.seal(input.secret!),
                        hookTokenHash: hashToken(token),
                        hookTokenCiphertext: this.secrets.seal(token),
                        configuredById: context.memberId!,
                    },
                }),
            );
        });
    }

    /** A new hook URL; the old one stops working at once. Slotline's webhook must be given the new one. */
    rotate(): Promise<SlotlineSettingsView> {
        return this.rls.withWorkspace(async (tx) => {
            const existing = await tx.slotlineSettings.findFirst();
            if (!existing) throw new ApiException(404, 'not_found', 'Slotline is not set up');
            const token = randomToken();
            return this.view(
                await tx.slotlineSettings.update({
                    where: { id: existing.id },
                    data: { hookTokenHash: hashToken(token), hookTokenCiphertext: this.secrets.seal(token) },
                }),
            );
        });
    }

    /** Stops taking bookings from Slotline; the meetings already stored stay. */
    async remove(): Promise<void> {
        await this.rls.withWorkspace((tx) => tx.slotlineSettings.deleteMany({}));
    }

    private view(row: SettingsRow | null): SlotlineSettingsView {
        return {
            configured: row !== null,
            baseUrl: row?.baseUrl ?? null,
            hookUrl: row
                ? new URL(
                      `${SLOTLINE_HOOK_PATH}/${this.secrets.open(row.hookTokenCiphertext)}`,
                      this.env.APP_URL,
                  ).toString()
                : null,
            triggers: [...SLOTLINE_BOOKING_TRIGGERS, ...SLOTLINE_CANCEL_TRIGGERS],
            lastDeliveryAt: row?.lastDeliveryAt ?? null,
            lastDeliveryResult: row?.lastDeliveryResult ?? null,
            unmatchedOrganizers: row?.unmatchedOrganizers ?? 0,
            lastUnmatchedOrganizer: row?.lastUnmatchedOrganizer ?? null,
        };
    }
}
