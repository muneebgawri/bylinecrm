import type { NewswireosPaymentMode } from '@bylinecrm/shared';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { hashToken } from '../auth/tokens';
import { ENV, type Env } from '../config/env';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext } from '../infra/workspace-context';
import { randomToken } from '../mail-accounts/oauth-flow';
import { NEWSWIREOS_HOOK_PATH } from './invoices.constants';
import type { NewswireosSettingsView } from './responses';

type SettingsRow = Prisma.NewswireosSettingsGetPayload<object>;

/**
 * The workspace's NewswireOS link (INV-1), an admin's to set: where to verify payments, the API token to verify
 * with, and the secret the refund/chargeback hook is signed with. Neither secret is ever shown back. The hook's
 * URL is made once (a new one on `rotate`), as Slotline's is. Without a link, invoices wait for a person with
 * `invoice:verify`.
 */
@Injectable()
export class NewswireosSettingsService {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
    ) {}

    get(): Promise<NewswireosSettingsView> {
        return this.rls.withWorkspace(async (tx) => this.view(await tx.newswireosSettings.findFirst()));
    }

    async put(input: {
        baseUrl: string;
        apiToken?: string | undefined;
        secret?: string | undefined;
        dashboardUrl?: string | null | undefined;
    }) {
        const context = this.context.get()!;
        if (!context.memberId) {
            throw new ApiException(403, 'forbidden', 'NewswireOS is linked by a member signed in, not by an API key');
        }
        const baseUrl = new URL(input.baseUrl).origin;
        return this.rls.withWorkspace(async (tx) => {
            const existing = await tx.newswireosSettings.findFirst();
            // The secret is not asked for here the first time: NewswireOS mints it only once it has this
            // workspace's hook URL, which linking makes. Deliveries are refused until it is pasted.
            if (!existing && !input.apiToken) {
                throw new ApiException(400, 'validation.failed', 'the API token is needed the first time');
            }
            const data = {
                baseUrl,
                configuredById: context.memberId!,
                ...(input.apiToken ? { apiTokenCiphertext: this.secrets.seal(input.apiToken) } : {}),
                ...(input.secret ? { secretCiphertext: this.secrets.seal(input.secret) } : {}),
                ...(input.dashboardUrl !== undefined
                    ? { dashboardUrl: input.dashboardUrl === null ? null : input.dashboardUrl.replace(/\/+$/, '') }
                    : {}),
            };
            if (existing) {
                return this.view(await tx.newswireosSettings.update({ where: { id: existing.id }, data }));
            }
            const token = randomToken();
            return this.view(
                await tx.newswireosSettings.create({
                    data: {
                        ...data,
                        workspaceId: context.workspaceId,
                        apiTokenCiphertext: this.secrets.seal(input.apiToken!),
                        secretCiphertext: input.secret ? this.secrets.seal(input.secret) : null,
                        hookTokenHash: hashToken(token),
                        hookTokenCiphertext: this.secrets.seal(token),
                    },
                }),
            );
        });
    }

    /** A new hook URL; the old one stops working at once. */
    rotate(): Promise<NewswireosSettingsView> {
        return this.rls.withWorkspace(async (tx) => {
            const existing = await tx.newswireosSettings.findFirst();
            if (!existing) throw new ApiException(404, 'not_found', 'NewswireOS is not linked');
            const token = randomToken();
            return this.view(
                await tx.newswireosSettings.update({
                    where: { id: existing.id },
                    data: { hookTokenHash: hashToken(token), hookTokenCiphertext: this.secrets.seal(token) },
                }),
            );
        });
    }

    /** INV-2: what a paid invoice NewswireOS reports does. `404` without a link. */
    async setPaymentMode(mode: NewswireosPaymentMode): Promise<NewswireosSettingsView> {
        const row = await this.rls.withWorkspace(async (tx) => {
            const { count } = await tx.newswireosSettings.updateMany({ data: { paymentMode: mode } });
            if (count === 0) throw new NotFoundException('NewswireOS is not linked');
            return tx.newswireosSettings.findFirst();
        });
        return this.view(row);
    }

    /** Unlinks NewswireOS: new invoices wait for a person; those already decided stay. */
    async remove(): Promise<void> {
        await this.rls.withWorkspace((tx) => tx.newswireosSettings.deleteMany({}));
    }

    private view(row: SettingsRow | null): NewswireosSettingsView {
        return {
            configured: row !== null,
            secretSet: row?.secretCiphertext != null,
            baseUrl: row?.baseUrl ?? null,
            hookUrl: row
                ? new URL(
                      `${NEWSWIREOS_HOOK_PATH}/${this.secrets.open(row.hookTokenCiphertext)}`,
                      this.env.APP_URL,
                  ).toString()
                : null,
            lastDeliveryAt: row?.lastDeliveryAt?.toISOString() ?? null,
            lastDeliveryResult: row?.lastDeliveryResult ?? null,
            pushOwnership: row?.pushOwnership ?? false,
            pushDealWon: row?.pushDealWon ?? false,
            paymentMode: (row?.paymentMode ?? 'shadow') as NewswireosPaymentMode,
            dashboardUrl: row?.dashboardUrl ?? null,
        };
    }
}
