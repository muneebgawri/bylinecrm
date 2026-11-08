import { Inject, Injectable } from '@nestjs/common';
import type { QuoSettingsView } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { ApiException, ValidationFailed } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext } from '../infra/workspace-context';
import { QUO_HOOK_PATH, QUO_WEBHOOK_EVENTS, QUO_WEBHOOK_LABEL } from './calls.constants';
import { QUO_API, QuoApiError, type QuoApi } from './quo.port';

type SettingsRow = Prisma.QuoSettingsGetPayload<object>;

/**
 * Settings → Quo (CALL-1), an admin's: saving the API key registers the CRM's receiver as a webhook at Quo (its
 * `whsec_` key sealed beside the API key) and matches Quo's users to members by email; unlinking deletes the
 * webhook at Quo. Calls already in stay.
 */
@Injectable()
export class QuoSettingsService {
    constructor(
        @Inject(ENV) private readonly env: Env,
        @Inject(QUO_API) private readonly quo: QuoApi,
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
    ) {}

    get(): Promise<QuoSettingsView> {
        return this.rls.withWorkspace(async (tx) => this.view(tx, await tx.quoSettings.findFirst()));
    }

    /** Saves the key, registers the webhook and matches users; a key Quo refuses is a `422` and nothing is kept. */
    async put(input: { apiKey: string }): Promise<QuoSettingsView> {
        const context = this.context.get()!;
        if (!context.memberId)
            throw new ApiException(403, 'forbidden', 'Quo is linked by a member signed in, not by an API key');
        const apiKey = input.apiKey.trim();
        // The network first, outside any transaction: the key must work before anything is written.
        let users;
        try {
            users = await this.quo.listUsers(apiKey);
        } catch (e) {
            if (e instanceof QuoApiError && e.kind === 'unauthorized') {
                throw new ValidationFailed('Quo refused this API key', [{ path: 'apiKey', message: 'refused by Quo' }]);
            }
            throw new ApiException(422, 'unprocessable', e instanceof Error ? e.message : 'Quo could not be reached');
        }
        const existing = await this.rls.withWorkspace((tx) => tx.quoSettings.findFirst());
        if (existing?.webhookId) {
            try {
                await this.quo.deleteWebhook(this.secrets.open(existing.apiKeyCiphertext), existing.webhookId);
            } catch {
                // The old key may be gone already; the new registration is what matters.
            }
        }
        const webhook = await this.quo.createWebhook(apiKey, {
            url: this.webhookUrl(context.workspaceId),
            events: QUO_WEBHOOK_EVENTS,
            label: QUO_WEBHOOK_LABEL,
        });
        return this.rls.withWorkspace(async (tx) => {
            const unmatched = await matchUsers(tx, users);
            const data = {
                apiKeyCiphertext: this.secrets.seal(apiKey),
                webhookId: webhook.id,
                webhookSecretCiphertext: this.secrets.seal(webhook.key),
                unmatchedQuoEmails: unmatched,
                configuredById: context.memberId!,
            };
            const row = existing
                ? await tx.quoSettings.update({ where: { id: existing.id }, data })
                : await tx.quoSettings.create({ data: { ...data, workspaceId: context.workspaceId } });
            return this.view(tx, row);
        });
    }

    /** Matches Quo's users to members again (someone joined Quo since); the key stays. */
    async rematch(): Promise<QuoSettingsView> {
        const existing = await this.rls.withWorkspace((tx) => tx.quoSettings.findFirst());
        if (!existing) throw new ApiException(404, 'not_found', 'Quo is not linked');
        const users = await this.quo.listUsers(this.secrets.open(existing.apiKeyCiphertext));
        return this.rls.withWorkspace(async (tx) => {
            const unmatched = await matchUsers(tx, users);
            return this.view(
                tx,
                await tx.quoSettings.update({ where: { id: existing.id }, data: { unmatchedQuoEmails: unmatched } }),
            );
        });
    }

    /** Unlinks Quo: the webhook is deleted there, the key forgotten here; calls already in stay. */
    async remove(): Promise<void> {
        const existing = await this.rls.withWorkspace((tx) => tx.quoSettings.findFirst());
        if (!existing) return;
        if (existing.webhookId) {
            try {
                await this.quo.deleteWebhook(this.secrets.open(existing.apiKeyCiphertext), existing.webhookId);
            } catch {
                // Unreachable or already gone: the key is forgotten either way, so deliveries stop being read.
            }
        }
        await this.rls.withWorkspace(async (tx) => {
            await tx.quoSettings.deleteMany({});
            await tx.workspaceMember.updateMany({ where: { quoUserId: { not: null } }, data: { quoUserId: null } });
        });
    }

    webhookUrl(workspaceId: string): string {
        return new URL(`/api/w/${workspaceId}/${QUO_HOOK_PATH}`, this.env.APP_URL).toString();
    }

    private async view(tx: WorkspaceClient, row: SettingsRow | null): Promise<QuoSettingsView> {
        const workspaceId = this.context.get()!.workspaceId;
        const matched = row
            ? (
                  await tx.workspaceMember.findMany({
                      where: { quoUserId: { not: null }, leftAt: null },
                      select: { id: true },
                  })
              ).map((m) => m.id)
            : [];
        return {
            configured: !!row,
            webhookUrl: this.webhookUrl(workspaceId),
            webhookRegistered: !!row?.webhookId,
            matchedMemberIds: matched,
            unmatchedQuoEmails: row?.unmatchedQuoEmails ?? [],
            lastDeliveryAt: row?.lastDeliveryAt?.toISOString() ?? null,
            lastDeliveryResult: row?.lastDeliveryResult ?? null,
        };
    }
}

/** Sets each member's Quo user by email (case-insensitive); returns the Quo emails no member has. */
async function matchUsers(
    tx: WorkspaceClient,
    users: readonly { id: string; email: string | null }[],
): Promise<string[]> {
    const members = await tx.workspaceMember.findMany({
        where: { leftAt: null },
        select: { id: true, user: { select: { email: true } } },
    });
    const byEmail = new Map(members.map((m) => [m.user.email.toLowerCase(), m.id]));
    const unmatched: string[] = [];
    const matchedMembers = new Set<string>();
    for (const u of users) {
        const email = u.email?.toLowerCase();
        const memberId = email ? byEmail.get(email) : undefined;
        if (!memberId) {
            if (email) unmatched.push(email);
            continue;
        }
        matchedMembers.add(memberId);
        await tx.workspaceMember.update({ where: { id: memberId }, data: { quoUserId: u.id } });
    }
    await tx.workspaceMember.updateMany({
        where: { id: { notIn: [...matchedMembers] }, quoUserId: { not: null } },
        data: { quoUserId: null },
    });
    return unmatched.sort();
}
