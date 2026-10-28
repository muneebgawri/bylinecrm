import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { DomainEvents } from '../events/domain-events.service';
import { RateLimiter } from '../auth/rate-limiter.service';
import { ApiException, RateLimited } from '../infra/errors/api-errors';
import { MailSendService } from '../mail-send/mail-send.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { randomToken } from '../mail-accounts/oauth-flow';
import { view as mailboxView } from '../mail-accounts/mailboxes.service';
import { actorOf } from '../records/actor';
import { enrolMailbox, sendingDomainOf } from '../sending-pool/pool-mailbox';
import { SMTP2GO_HOOK_PATH, SMTP2GO_TEST_LIMIT, SMTP2GO_TEST_WINDOW_S, smtp2goTestRateKey } from './smtp2go.constants';
import type { Smtp2GoMailboxView, Smtp2GoTestResult } from './responses';

type MailboxRow = Prisma.MailboxGetPayload<object>;

/**
 * SMTP2Go pool mailboxes (TRANS-1), an admin's to add: an address on a domain SMTP2Go is set up to send for, the
 * API key it sends with (sealed, never shown back), and a hook secret the CRM makes for SMTP2Go's webhook to send
 * as `Authorization: Bearer …`. Such a mailbox is always `pool` — the database refuses anything else — so 1:1 and
 * personal mail never leave through SMTP2Go. It joins the pool like a Gmail pool mailbox: its sending domain is
 * enrolled and gated by its DNS check, and its warm-up starts. Disconnecting it is the mailbox route's
 * (`DELETE /mailboxes/:id`), which wipes the key and the secret.
 */
@Injectable()
export class Smtp2GoMailboxesService {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        private readonly events: DomainEvents,
        private readonly sends: MailSendService,
        private readonly limiter: RateLimiter,
    ) {}

    list(): Promise<Smtp2GoMailboxView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.mailbox.findMany({
                where: { transport: 'smtp2go' },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            });
            return rows.map((row) => this.view(row));
        });
    }

    /**
     * Adds (or connects again) an SMTP2Go pool mailbox, owned by the admin adding it — the pool's mail speaks as
     * its owner. An address already working in the workspace, through either transport, is a conflict.
     */
    add(input: {
        email: string;
        label?: string | null | undefined;
        apiKey: string;
        dkimSelector?: string | undefined;
    }) {
        const context = this.member();
        const email = input.email.toLowerCase();
        return this.rls.withWorkspace(async (tx) => {
            const existing = await tx.mailbox.findUnique({
                where: { workspaceId_email: { workspaceId: context.workspaceId, email } },
            });
            if (existing && existing.status !== 'disconnected') {
                throw new ApiException(409, 'conflict', 'that address is already a mailbox here; disconnect it first', [
                    { path: 'email', message: 'already connected in this workspace' },
                ]);
            }
            const data = {
                purpose: 'pool' as const,
                transport: 'smtp2go' as const,
                status: 'connected' as const,
                ownerMemberId: context.memberId,
                label: input.label ?? existing?.label ?? null,
                grantedScopes: [],
                refreshTokenCiphertext: null,
                accessTokenCiphertext: null,
                accessExpiresAt: null,
                transportKeyCiphertext: this.secrets.seal(input.apiKey),
                hookSecretCiphertext: this.secrets.seal(randomToken()),
                lastError: Prisma.DbNull,
                lastHookAt: null,
                lastHookResult: null,
                connectedAt: new Date(),
            };
            const row = existing
                ? await tx.mailbox.update({ where: { id: existing.id }, data })
                : await tx.mailbox.create({ data: { ...data, workspaceId: context.workspaceId, email } });
            await enrolMailbox(tx, row);
            if (input.dkimSelector) {
                await tx.sendingDomain.updateMany({
                    where: { domain: sendingDomainOf(email) },
                    data: { dkimSelector: input.dkimSelector, nextCheckAt: new Date() },
                });
            }
            await this.events.record(tx, {
                type: 'mailbox.connected',
                object: 'mailbox',
                workspaceId: context.workspaceId,
                actor: actorOf(context),
                occurredAt: new Date().toISOString(),
                recordId: row.id,
            });
            return this.view(row);
        });
    }

    /** Replaces the API key (a key revoked or rotated in SMTP2Go); the mailbox works again if it had stopped. */
    replaceKey(id: string, apiKey: string): Promise<Smtp2GoMailboxView> {
        return this.rls.withWorkspace(async (tx) => {
            const row = await this.live(tx, id);
            return this.view(
                await tx.mailbox.update({
                    where: { id: row.id },
                    data: {
                        transportKeyCiphertext: this.secrets.seal(apiKey),
                        status: 'connected',
                        lastError: Prisma.DbNull,
                    },
                }),
            );
        });
    }

    /** A new hook secret; the old one is refused at once — give SMTP2Go the new header. */
    rotateSecret(id: string): Promise<Smtp2GoMailboxView> {
        return this.rls.withWorkspace(async (tx) => {
            const row = await this.live(tx, id);
            return this.view(
                await tx.mailbox.update({
                    where: { id: row.id },
                    data: { hookSecretCiphertext: this.secrets.seal(randomToken()) },
                }),
            );
        });
    }

    /**
     * "Send test": one message through this mailbox's SMTP2Go key to the admin asking (`MailSendService`), with a
     * link SMTP2Go's click tracking can follow, so the settings page shows its webhook's result. Rate-limited per
     * mailbox; the answer says whether it went or why not.
     */
    async sendTest(id: string): Promise<Smtp2GoTestResult> {
        const { workspaceId } = this.member();
        await this.rls.withWorkspace((tx) => this.live(tx, id));
        if (await this.limiter.hit(smtp2goTestRateKey(id), SMTP2GO_TEST_LIMIT, SMTP2GO_TEST_WINDOW_S)) {
            throw new RateLimited('too many tests from this mailbox; try again in an hour');
        }
        const link = new URL(`/w/${workspaceId}/settings/smtp2go`, this.env.APP_URL).toString();
        const subject = 'BylineCRM test through SMTP2Go';
        const text = `This is a test from BylineCRM, sent through SMTP2Go to check this pool mailbox and its webhook.\n\nSettings: ${link}\n`;
        const html = `<p>This is a test from BylineCRM, sent through SMTP2Go to check this pool mailbox and its webhook.</p><p><a href="${link}">Open Settings › SMTP2Go</a></p>`;
        return this.sends.sendSmtp2GoTest(id, { subject, text, html });
    }

    private async live(tx: WorkspaceClient, id: string): Promise<MailboxRow> {
        const row = await tx.mailbox.findFirst({ where: { id, transport: 'smtp2go' } });
        if (!row) throw new ApiException(404, 'not_found', 'SMTP2Go mailbox not found');
        if (row.status === 'disconnected') {
            throw new ApiException(409, 'conflict', 'the mailbox is disconnected; add it again with its API key');
        }
        return row;
    }

    private view(row: MailboxRow): Smtp2GoMailboxView {
        return {
            mailbox: mailboxView(row),
            hookUrl: new URL(`${SMTP2GO_HOOK_PATH}/${row.id}`, this.env.APP_URL).toString(),
            hookAuthorization: row.hookSecretCiphertext
                ? `Bearer ${this.secrets.open(row.hookSecretCiphertext)}`
                : null,
            lastHookAt: row.lastHookAt,
            lastHookResult: row.lastHookResult as Smtp2GoMailboxView['lastHookResult'],
        };
    }

    private member(): WorkspaceRunContext & { memberId: string } {
        const context = this.context.get();
        if (!context) throw new Error('SMTP2Go mailboxes used outside a workspace context');
        if (!context.memberId) {
            throw new ApiException(
                403,
                'forbidden',
                'an SMTP2Go mailbox is added by a member signed in, not an API key',
            );
        }
        return context as WorkspaceRunContext & { memberId: string };
    }
}
