import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { ApiException, ValidationFailed } from '../infra/errors/api-errors';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext } from '../infra/workspace-context';
import { BYLINE_INBOUND_PATH } from './byline.constants';
import type { BylineSettingsView } from './responses';

type SettingsRow = Prisma.BylineSettingsGetPayload<object>;

/**
 * The workspace's BylineAI link (BYL-1), an admin's to set: the secret lead deliveries are signed with (encrypted,
 * never shown back) and the members leads at unowned companies are dealt to. The receiver's URL is the workspace's
 * own, so there is nothing to rotate but the secret.
 */
@Injectable()
export class BylineSettingsService {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
    ) {}

    get(): Promise<BylineSettingsView> {
        return this.rls.withWorkspace(async (tx) => this.view(await tx.bylineSettings.findFirst()));
    }

    async put(input: {
        secret?: string | undefined;
        roundRobinMemberIds?: string[] | undefined;
        baseUrl?: string | null | undefined;
        apiKey?: string | undefined;
        verifyWithByline?: boolean | undefined;
    }) {
        const context = this.context.get()!;
        if (!context.memberId) {
            throw new ApiException(403, 'forbidden', 'BylineAI is linked by a member signed in, not by an API key');
        }
        return this.rls.withWorkspace(async (tx) => {
            const existing = await tx.bylineSettings.findFirst();
            // The webhook (BYL-1), the API (BYL-2), or both; the API's address and key go together.
            const baseUrl = input.baseUrl === undefined ? undefined : input.baseUrl && new URL(input.baseUrl).origin;
            const apiLinked = baseUrl === undefined ? !!existing?.baseUrl : baseUrl !== null;
            if (baseUrl && !input.apiKey && !existing?.apiKeyCiphertext) {
                throw new ValidationFailed('BylineAI’s API key is needed with its address', [
                    { path: 'apiKey', message: 'needed the first time' },
                ]);
            }
            if (!(input.secret ?? existing?.secretCiphertext) && !apiLinked) {
                throw new ValidationFailed('the webhook secret, or BylineAI’s address and API key, are needed');
            }
            if (input.verifyWithByline && !apiLinked) {
                throw new ValidationFailed('verification by BylineAI needs its address and API key', [
                    { path: 'verifyWithByline', message: 'link BylineAI’s API first' },
                ]);
            }
            const roundRobin = input.roundRobinMemberIds ? [...new Set(input.roundRobinMemberIds)] : undefined;
            if (roundRobin && roundRobin.length > 0) {
                const found = await tx.workspaceMember.count({ where: { id: { in: roundRobin }, leftAt: null } });
                if (found !== roundRobin.length) {
                    throw new ValidationFailed('every round-robin member must be in the workspace', [
                        { path: 'roundRobinMemberIds', message: 'not a member of this workspace' },
                    ]);
                }
            }
            const data = {
                configuredById: context.memberId!,
                ...(input.secret ? { secretCiphertext: this.secrets.seal(input.secret) } : {}),
                ...(roundRobin ? { roundRobinMemberIds: roundRobin } : {}),
                ...(baseUrl === null ? { baseUrl: null, apiKeyCiphertext: null, verifyWithByline: false } : {}),
                ...(baseUrl ? { baseUrl } : {}),
                ...(baseUrl !== null && input.apiKey ? { apiKeyCiphertext: this.secrets.seal(input.apiKey) } : {}),
                ...(input.verifyWithByline !== undefined && baseUrl !== null
                    ? { verifyWithByline: input.verifyWithByline }
                    : {}),
            };
            if (existing) return this.view(await tx.bylineSettings.update({ where: { id: existing.id }, data }));
            return this.view(
                await tx.bylineSettings.create({
                    data: { ...data, workspaceId: context.workspaceId },
                }),
            );
        });
    }

    /** Unlinks BylineAI: deliveries are refused from now on; leads already in stay. */
    async remove(): Promise<void> {
        await this.rls.withWorkspace((tx) => tx.bylineSettings.deleteMany({}));
    }

    private view(row: SettingsRow | null): BylineSettingsView {
        const workspaceId = this.context.get()!.workspaceId;
        return {
            configured: !!row?.secretCiphertext,
            apiConfigured: !!row?.apiKeyCiphertext,
            baseUrl: row?.baseUrl ?? null,
            verifyWithByline: row?.verifyWithByline ?? false,
            webhookUrl: new URL(`/api/w/${workspaceId}/${BYLINE_INBOUND_PATH}`, this.env.APP_URL).toString(),
            roundRobinMemberIds: row?.roundRobinMemberIds ?? [],
            lastDeliveryAt: row?.lastDeliveryAt?.toISOString() ?? null,
            lastDeliveryResult: row?.lastDeliveryResult ?? null,
        };
    }
}
