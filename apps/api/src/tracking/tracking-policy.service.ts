import { Inject, Injectable } from '@nestjs/common';
import { gmailInsertGranted, type TrackingPolicyView, type TrackingProvider } from '@bylinecrm/shared';
import type { TrackingPolicy } from '@prisma/client';
import { randomToken } from '../auth/tokens';
import { ENV, type Env } from '../config/env';
import { ValidationFailed } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext } from '../infra/workspace-context';
import { SMTP2GO_RELAY_HOOK_PATH } from '../smtp2go/smtp2go.constants';

/** What the send path reads of the policy; a workspace with no row has the defaults. */
export interface TrackingRules {
    provider: TrackingProvider;
    trackOpens: boolean;
    trackClicks: boolean;
    trackPersonalMail: boolean;
    gmailReplyNotices: boolean;
    /** The SMTP2Go key CRM-written mail goes through, sealed; null when none is set. */
    relayKeyCiphertext: string | null;
}

export const DEFAULT_TRACKING_RULES: Readonly<TrackingRules> = Object.freeze({
    provider: 'builtin',
    trackOpens: true,
    trackClicks: true,
    trackPersonalMail: false,
    gmailReplyNotices: true,
    relayKeyCiphertext: null,
});

/** What an admin may change; every field optional. `smtp2goApiKey: null` removes the key. */
export interface TrackingPolicyInput {
    provider?: TrackingProvider | undefined;
    trackOpens?: boolean | undefined;
    trackClicks?: boolean | undefined;
    trackPersonalMail?: boolean | undefined;
    gmailReplyNotices?: boolean | undefined;
    smtp2goApiKey?: string | null | undefined;
}

/** The rules of a workspace, read in the caller's transaction. */
export async function trackingRulesIn(tx: WorkspaceClient, workspaceId: string): Promise<TrackingRules> {
    const row = await tx.trackingPolicy.findUnique({ where: { workspaceId } });
    return row ? rulesOf(row) : { ...DEFAULT_TRACKING_RULES };
}

function rulesOf(row: TrackingPolicy): TrackingRules {
    return {
        provider: row.provider,
        trackOpens: row.trackOpens,
        trackClicks: row.trackClicks,
        trackPersonalMail: row.trackPersonalMail,
        gmailReplyNotices: row.gmailReplyNotices,
        relayKeyCiphertext: row.relayKeyCiphertext,
    };
}

/**
 * TRACK-2: how the workspace tracks its mail, an admin's (Settings → Tracking). `builtin` tracks with our short
 * links and pixel (the short-link domain must pass its check); `smtp2go` sends CRM-written mail through SMTP2Go with
 * the key set here — SMTP2Go tracks it and reports through the webhook named here — and keeps a copy in the sender's
 * Gmail Sent. SMTP2Go can be chosen only with a key. The key is sealed and never returned; the webhook's secret is
 * made with the key and shown, as a pool mailbox's is.
 */
@Injectable()
export class TrackingPolicyService {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
    ) {}

    async get(): Promise<TrackingPolicyView> {
        return this.rls.withWorkspace(async (tx) => this.view(tx, await this.row(tx)));
    }

    async update(input: TrackingPolicyInput): Promise<TrackingPolicyView> {
        const context = this.context.get();
        if (!context) throw new Error('TrackingPolicyService is used inside a workspace scope');
        const { workspaceId } = context;
        return this.rls.withWorkspace(async (tx) => {
            const current = await this.row(tx);
            const key =
                input.smtp2goApiKey === undefined
                    ? undefined
                    : input.smtp2goApiKey === null
                      ? null
                      : this.secrets.seal(input.smtp2goApiKey);
            const keyAfter = key === undefined ? (current?.relayKeyCiphertext ?? null) : key;
            const provider = input.provider ?? current?.provider ?? 'builtin';
            if (provider === 'smtp2go' && !keyAfter) {
                throw new ValidationFailed('SMTP2Go tracks only with its API key', [
                    { path: 'smtp2goApiKey', message: 'set the SMTP2Go API key to choose SMTP2Go' },
                ]);
            }
            const data = {
                provider,
                ...(input.trackOpens !== undefined ? { trackOpens: input.trackOpens } : {}),
                ...(input.trackClicks !== undefined ? { trackClicks: input.trackClicks } : {}),
                ...(input.trackPersonalMail !== undefined ? { trackPersonalMail: input.trackPersonalMail } : {}),
                ...(input.gmailReplyNotices !== undefined ? { gmailReplyNotices: input.gmailReplyNotices } : {}),
                ...(key !== undefined
                    ? {
                          relayKeyCiphertext: key,
                          // A new key gets a new webhook secret (SMTP2Go is set up again with it); no key, no hook.
                          relayHookSecretCiphertext: key ? this.secrets.seal(randomToken()) : null,
                      }
                    : {}),
                updatedById: context.memberId ?? null,
            };
            const row = await tx.trackingPolicy.upsert({
                where: { workspaceId },
                create: { workspaceId, ...data },
                update: data,
            });
            return this.view(tx, row);
        });
    }

    private row(tx: WorkspaceClient): Promise<TrackingPolicy | null> {
        const context = this.context.get();
        if (!context) throw new Error('TrackingPolicyService is used inside a workspace scope');
        return tx.trackingPolicy.findUnique({ where: { workspaceId: context.workspaceId } });
    }

    private async view(tx: WorkspaceClient, row: TrackingPolicy | null): Promise<TrackingPolicyView> {
        const rules = row ? rulesOf(row) : DEFAULT_TRACKING_RULES;
        const workspaceId = this.context.get()!.workspaceId;
        const personal = await tx.mailbox.findMany({
            where: { purpose: 'personal', transport: 'gmail', status: 'connected' },
            select: { id: true, email: true, grantedScopes: true },
            orderBy: { email: 'asc' },
        });
        return {
            provider: rules.provider,
            trackOpens: rules.trackOpens,
            trackClicks: rules.trackClicks,
            trackPersonalMail: rules.trackPersonalMail,
            gmailReplyNotices: rules.gmailReplyNotices,
            smtp2go: {
                keySet: rules.relayKeyCiphertext !== null,
                hookUrl: new URL(`${SMTP2GO_RELAY_HOOK_PATH}/${workspaceId}`, this.env.APP_URL).toString(),
                // The secret is an admin's to set up in SMTP2Go: nobody else is shown it.
                hookAuthorization:
                    row?.relayHookSecretCiphertext && this.context.get()!.capabilities.has('workspace:admin')
                        ? `Bearer ${this.secrets.open(row.relayHookSecretCiphertext)}`
                        : null,
                lastHookAt: row?.lastRelayHookAt?.toISOString() ?? null,
                lastHookResult: row?.lastRelayHookResult ?? null,
            },
            mailboxesWithoutCopy: personal
                .filter((m) => !gmailInsertGranted(m.grantedScopes))
                .map((m) => ({ id: m.id, email: m.email })),
        };
    }
}
