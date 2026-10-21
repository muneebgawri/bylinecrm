import { Inject, Injectable, Logger } from '@nestjs/common';
import {
    DELEGATION_SCOPES,
    GMAIL_READONLY_SCOPE,
    type DelegationAuditAction,
    type DelegationMemberState,
} from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { ApiException, ValidationFailed } from '../infra/errors/api-errors';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { parseServiceAccountKey, ServiceAccountKeyRejected } from './google-delegation.http';
import { GOOGLE_DELEGATION_PORT, type DelegatedToken, type GoogleDelegationPort } from './google-delegation.port';
import { GoogleOAuthError } from './google-oauth.port';
import { DELEGATION_AUDIT_PAGE, DELEGATION_AUDIT_RETENTION_DAYS } from './mail-accounts.constants';
import type { DelegationAuditEntry, DelegationCheck, DelegationMember, DelegationView } from './responses';

type SettingsRow = Prisma.GoogleWorkspaceDelegationGetPayload<object>;
type MailboxRow = Prisma.MailboxGetPayload<object>;

/**
 * Google Workspace domain-wide delegation (#225). An admin uploads a service account's JSON key (sealed,
 * write-only) and names the allowed domains; a check mints a token for the admin's own address, one scope
 * at a time, and records which scopes the Admin console authorises. Once Gmail read is authorised, every
 * workspace member whose address is in an allowed domain — not excluded by an admin, and without an OAuth
 * connection of their own, which always wins — gets a delegated mailbox: an ordinary mailbox row whose
 * tokens `MailboxTokens` mints here instead of refreshing, so mail and calendar sync run unchanged. Only
 * workspace members are ever synced, never other mailboxes in the domain. Every key or setting change
 * and every delegated sync start is written to the delegation's audit log.
 */
@Injectable()
export class DelegationService {
    private readonly logger = new Logger(DelegationService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly owner: PrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        @Inject(GOOGLE_DELEGATION_PORT) private readonly google: GoogleDelegationPort,
    ) {}

    // ── Settings (admin) ─────────────────────────────────────────────────────────────────────

    describe(): Promise<DelegationView> {
        return this.rls.withWorkspace(async (tx) => this.view(tx, await tx.googleWorkspaceDelegation.findFirst()));
    }

    /**
     * Stores the key (sealed) and checks it at once. A different service account starts unproven: its
     * granted scopes are cleared and every delegated mailbox's cached token goes, so nothing minted by the
     * old account is used again.
     */
    async putKey(text: string): Promise<DelegationView> {
        const context = this.current();
        const memberId = requireMember(context);
        let key;
        try {
            key = parseServiceAccountKey(text);
        } catch (error) {
            if (error instanceof ServiceAccountKeyRejected)
                throw new ValidationFailed(error.message, [{ path: 'key', message: error.message }]);
            throw error;
        }
        await this.rls.withWorkspace(async (tx) => {
            const existing = await tx.googleWorkspaceDelegation.findFirst();
            const data = {
                keyCiphertext: this.secrets.seal(text),
                clientEmail: key.clientEmail,
                clientId: key.clientId,
                privateKeyIdLast4: key.privateKeyId.slice(-4),
                grantedScopes: [],
                lastCheck: Prisma.DbNull,
                updatedById: memberId,
            };
            if (existing)
                await tx.googleWorkspaceDelegation.update({ where: { workspaceId: context.workspaceId }, data });
            else await tx.googleWorkspaceDelegation.create({ data: { workspaceId: context.workspaceId, ...data } });
            await tx.mailbox.updateMany({
                where: { credentialSource: 'delegation' },
                data: { accessTokenCiphertext: null, accessExpiresAt: null },
            });
            await audit(tx, context.workspaceId, 'key_set', {
                actorMemberId: memberId,
                detail: {
                    clientEmail: key.clientEmail,
                    clientId: key.clientId,
                    replaced: existing !== null,
                    sameAccount: existing?.clientEmail === key.clientEmail,
                },
            });
        });
        return this.check();
    }

    /** Removes the key; every delegated mailbox stops (its row and sync history stay, disconnected). */
    async removeKey(): Promise<void> {
        const context = this.current();
        const memberId = requireMember(context);
        await this.rls.withWorkspace(async (tx) => {
            const existing = await tx.googleWorkspaceDelegation.findFirst();
            if (!existing) throw new ApiException(404, 'not_found', 'no service account is configured');
            await tx.googleWorkspaceDelegation.delete({ where: { workspaceId: context.workspaceId } });
            await audit(tx, context.workspaceId, 'key_removed', {
                actorMemberId: memberId,
                detail: { clientEmail: existing.clientEmail, clientId: existing.clientId },
            });
        });
        await this.reconcile(context.workspaceId);
    }

    async setDomains(allowedDomains: string[]): Promise<DelegationView> {
        const context = this.current();
        const memberId = requireMember(context);
        const domains = [...new Set(allowedDomains)].sort();
        await this.rls.withWorkspace(async (tx) => {
            const existing = await this.settingsOrThrow(tx);
            await tx.googleWorkspaceDelegation.update({
                where: { workspaceId: context.workspaceId },
                data: { allowedDomains: domains, updatedById: memberId },
            });
            await audit(tx, context.workspaceId, 'domains_changed', {
                actorMemberId: memberId,
                detail: { from: existing.allowedDomains, to: domains },
            });
        });
        await this.reconcile(context.workspaceId);
        return this.describe();
    }

    /**
     * Mints a token for the admin's own address, once per scope, and records which scopes the Admin
     * console authorises. A passing check also brings back delegated mailboxes a refusal had stopped.
     */
    async check(): Promise<DelegationView> {
        const context = this.current();
        const memberId = requireMember(context);
        const { settings, subject } = await this.rls.withWorkspace(async (tx) => ({
            settings: await this.settingsOrThrow(tx),
            subject: await memberAddress(tx, memberId),
        }));
        const key = parseServiceAccountKey(this.secrets.open(settings.keyCiphertext));
        const scopes: DelegationCheck['scopes'] = [];
        for (const scope of DELEGATION_SCOPES) {
            try {
                await this.google.mint(key, subject, [scope]);
                scopes.push({ scope, granted: true, error: null });
            } catch (error) {
                if (!(error instanceof GoogleOAuthError)) throw error;
                scopes.push({ scope, granted: false, error: error.error });
            }
        }
        const granted = scopes.filter((s) => s.granted).map((s) => s.scope);
        const check: DelegationCheck = { checkedAt: new Date(), subject, scopes };
        await this.rls.withWorkspace(async (tx) => {
            await tx.googleWorkspaceDelegation.update({
                where: { workspaceId: context.workspaceId },
                data: {
                    grantedScopes: granted,
                    lastCheck: { ...check, checkedAt: check.checkedAt.toISOString() },
                },
            });
            if (granted.includes(GMAIL_READONLY_SCOPE)) {
                await tx.mailbox.updateMany({
                    where: { credentialSource: 'delegation', status: 'reconnect_needed' },
                    data: {
                        status: 'connected',
                        lastError: Prisma.DbNull,
                        accessTokenCiphertext: null,
                        accessExpiresAt: null,
                    },
                });
            }
            await audit(tx, context.workspaceId, 'checked', {
                actorMemberId: memberId,
                detail: { subject, granted },
            });
        });
        await this.reconcile(context.workspaceId);
        return this.describe();
    }

    /** Every member in the workspace and how they stand with delegation. */
    members(): Promise<DelegationMember[]> {
        return this.rls.withWorkspace(async (tx) => {
            const settings = await tx.googleWorkspaceDelegation.findFirst();
            const plan = await planFor(tx, settings);
            return plan.members.map((m) => ({
                memberId: m.id,
                name: m.name,
                email: m.email,
                state: m.state,
                excluded: m.excluded,
                mailboxId: m.delegated?.id ?? null,
                mailboxStatus: m.delegated?.status ?? null,
            }));
        });
    }

    async setExcluded(memberId: string, excluded: boolean): Promise<DelegationMember> {
        const context = this.current();
        const actor = requireMember(context);
        await this.rls.withWorkspace(async (tx) => {
            const settings = await this.settingsOrThrow(tx);
            const member = await tx.workspaceMember.findFirst({ where: { id: memberId, leftAt: null } });
            if (!member) throw new ApiException(404, 'not_found', 'member not found');
            const was = settings.excludedMemberIds.includes(memberId);
            if (was === excluded) return;
            await tx.googleWorkspaceDelegation.update({
                where: { workspaceId: context.workspaceId },
                data: {
                    excludedMemberIds: excluded
                        ? [...settings.excludedMemberIds, memberId]
                        : settings.excludedMemberIds.filter((id) => id !== memberId),
                    updatedById: actor,
                },
            });
            await audit(tx, context.workspaceId, excluded ? 'member_excluded' : 'member_included', {
                actorMemberId: actor,
                subjectMemberId: memberId,
            });
        });
        await this.reconcile(context.workspaceId);
        const row = (await this.members()).find((m) => m.memberId === memberId);
        if (!row) throw new ApiException(404, 'not_found', 'member not found');
        return row;
    }

    auditLog(): Promise<DelegationAuditEntry[]> {
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.googleWorkspaceDelegationAudit.findMany({
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: DELEGATION_AUDIT_PAGE,
            });
            return rows.map((r) => ({
                id: r.id,
                action: r.action as DelegationAuditAction,
                actorMemberId: r.actorMemberId,
                subjectMemberId: r.subjectMemberId,
                mailboxId: r.mailboxId,
                detail: r.detail as Record<string, unknown>,
                createdAt: r.createdAt,
            }));
        });
    }

    // ── Tokens and sync (workers) ────────────────────────────────────────────────────────────

    /**
     * A token for a delegated mailbox's address, carrying the scopes the last check found authorised.
     * `MailboxTokens` caches it on the mailbox, sealed, until shortly before it expires.
     */
    async mint(workspaceId: string, subject: string): Promise<DelegatedToken & { scopes: string[] }> {
        const settings = await this.rls.withWorkspace(workspaceId, (tx) => tx.googleWorkspaceDelegation.findFirst());
        if (!settings || !isActive(settings)) {
            throw new GoogleOAuthError('not_configured', null, 'Workspace delegation is not set up');
        }
        const scopes = DELEGATION_SCOPES.filter((s) => settings.grantedScopes.includes(s));
        const key = parseServiceAccountKey(this.secrets.open(settings.keyCiphertext));
        return { ...(await this.google.mint(key, subject, scopes)), scopes };
    }

    /** Writes a delegated mailbox's sync start to the audit log; a mailbox with its own grant is not logged. */
    async noteSyncStart(
        mailbox: Pick<MailboxRow, 'id' | 'workspaceId' | 'credentialSource' | 'status' | 'ownerMemberId' | 'email'>,
        kind: 'mail' | 'calendar',
    ): Promise<void> {
        if (mailbox.credentialSource !== 'delegation' || mailbox.status !== 'connected') return;
        await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            audit(tx, mailbox.workspaceId, kind === 'mail' ? 'mail_sync_started' : 'calendar_sync_started', {
                subjectMemberId: mailbox.ownerMemberId,
                mailboxId: mailbox.id,
                detail: { email: mailbox.email },
            }),
        );
    }

    /**
     * Brings every workspace's delegated mailboxes in line with its settings and members; run by the mail
     * sync tick, so a member who joins, leaves, connects or disconnects is picked up within one tick. Old
     * audit entries are swept here too.
     */
    async reconcileAll(): Promise<void> {
        const [configured, delegated] = await Promise.all([
            this.owner.googleWorkspaceDelegation.findMany({ select: { workspaceId: true } }),
            this.owner.mailbox.findMany({
                where: { credentialSource: 'delegation', status: { not: 'disconnected' } },
                select: { workspaceId: true },
                distinct: ['workspaceId'],
            }),
        ]);
        const ids = new Set([...configured, ...delegated].map((r) => r.workspaceId));
        for (const workspaceId of ids) {
            try {
                await this.reconcile(workspaceId);
            } catch (error) {
                this.logger.error(`delegation reconcile failed in workspace ${workspaceId}: ${String(error)}`);
            }
        }
        await this.owner.googleWorkspaceDelegationAudit.deleteMany({
            where: { createdAt: { lt: new Date(Date.now() - DELEGATION_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000) } },
        });
    }

    /**
     * One workspace: a delegated mailbox for each member who should have one (created, or brought back with
     * its sync history), and every other delegated mailbox disconnected. An address that is someone else's
     * live mailbox, or a pool mailbox's, is left alone.
     */
    async reconcile(workspaceId: string): Promise<void> {
        await this.rls.withWorkspace(workspaceId, async (tx) => {
            // One reconcile per workspace at a time: the tick and an admin's change may overlap.
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`gws-delegation:${workspaceId}`}))::text`;
            const settings = await tx.googleWorkspaceDelegation.findFirst();
            const plan = await planFor(tx, settings);
            const scopes = settings ? DELEGATION_SCOPES.filter((s) => settings.grantedScopes.includes(s)) : [];
            const desired = new Set<string>();
            for (const m of plan.members) {
                if (m.state !== 'delegated' || !plan.active) continue;
                desired.add(m.email);
                const row = plan.byEmail.get(m.email);
                const live = {
                    status: 'connected' as const,
                    ownerMemberId: m.id,
                    grantedScopes: scopes,
                    lastError: Prisma.DbNull,
                };
                if (!row) {
                    await tx.mailbox.create({
                        data: {
                            ...live,
                            workspaceId,
                            email: m.email,
                            purpose: 'personal',
                            transport: 'gmail',
                            credentialSource: 'delegation',
                            connectedAt: new Date(),
                        },
                    });
                } else if (row.credentialSource === 'delegation') {
                    if (row.status === 'disconnected' || row.ownerMemberId !== m.id) {
                        await tx.mailbox.update({ where: { id: row.id }, data: { ...live, connectedAt: new Date() } });
                    } else if (!sameScopes(row.grantedScopes, scopes)) {
                        await tx.mailbox.update({
                            where: { id: row.id },
                            data: { grantedScopes: scopes, accessTokenCiphertext: null, accessExpiresAt: null },
                        });
                    }
                } else if (row.status === 'disconnected' && row.purpose === 'personal' && row.transport === 'gmail') {
                    // The member's own mailbox, disconnected: it syncs again through the service account.
                    await tx.mailbox.update({
                        where: { id: row.id },
                        data: {
                            ...live,
                            credentialSource: 'delegation',
                            refreshTokenCiphertext: null,
                            accessTokenCiphertext: null,
                            accessExpiresAt: null,
                            connectedAt: new Date(),
                        },
                    });
                }
            }
            await tx.mailbox.updateMany({
                where: {
                    credentialSource: 'delegation',
                    status: { not: 'disconnected' },
                    email: { notIn: [...desired] },
                },
                data: { status: 'disconnected', accessTokenCiphertext: null, accessExpiresAt: null },
            });
        });
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    private async view(tx: WorkspaceClient, row: SettingsRow | null): Promise<DelegationView> {
        const delegatedMailboxes = await tx.mailbox.count({
            where: { credentialSource: 'delegation', status: 'connected' },
        });
        return {
            configured: row !== null,
            clientEmail: row?.clientEmail ?? null,
            clientId: row?.clientId ?? null,
            privateKeyIdLast4: row?.privateKeyIdLast4 ?? null,
            allowedDomains: row?.allowedDomains ?? [],
            scopes: [...DELEGATION_SCOPES],
            grantedScopes: row?.grantedScopes ?? [],
            active: row ? isActive(row) : false,
            lastCheck: row?.lastCheck ? readCheck(row.lastCheck) : null,
            delegatedMailboxes,
            updatedAt: row?.updatedAt ?? null,
        };
    }

    private async settingsOrThrow(tx: WorkspaceClient): Promise<SettingsRow> {
        const row = await tx.googleWorkspaceDelegation.findFirst();
        if (!row) throw new ApiException(409, 'conflict', 'no service account is configured; upload its key first');
        return row;
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('delegation used outside a workspace context');
        return context;
    }
}

/**
 * Delegation syncs once it has a domain to sync and the Admin console authorises Gmail read; sending
 * also needs Gmail send, which the check reports when it is missing.
 */
export function isActive(row: Pick<SettingsRow, 'allowedDomains' | 'grantedScopes'>): boolean {
    return row.allowedDomains.length > 0 && row.grantedScopes.includes(GMAIL_READONLY_SCOPE);
}

/** The domain part of an address is one of the allowed domains, exactly (a subdomain is not). */
export function inAllowedDomains(email: string, domains: readonly string[]): boolean {
    const at = email.lastIndexOf('@');
    return at > 0 && domains.includes(email.slice(at + 1).toLowerCase());
}

interface PlannedMember {
    id: string;
    name: string | null;
    email: string;
    excluded: boolean;
    state: DelegationMemberState;
    delegated: { id: string; status: MailboxRow['status'] } | null;
}

/**
 * Every member in the workspace and whether they sync through the service account: in an allowed
 * domain, not excluded, and without a live OAuth mailbox of their own (one that is connected or awaits
 * reconnecting) — their own connection wins.
 */
async function planFor(
    tx: WorkspaceClient,
    settings: SettingsRow | null,
): Promise<{ active: boolean; members: PlannedMember[]; byEmail: Map<string, MailboxRow> }> {
    const [members, mailboxes] = await Promise.all([
        tx.workspaceMember.findMany({
            where: { leftAt: null },
            select: { id: true, user: { select: { email: true, displayName: true } } },
            orderBy: { createdAt: 'asc' },
        }),
        tx.mailbox.findMany(),
    ]);
    const ownConnection = new Set(
        mailboxes
            .filter((m) => m.credentialSource === 'oauth' && m.purpose === 'personal' && m.status !== 'disconnected')
            .map((m) => m.ownerMemberId),
    );
    const byEmail = new Map(mailboxes.map((m) => [m.email, m]));
    const domains = settings?.allowedDomains ?? [];
    const excludedIds = new Set(settings?.excludedMemberIds ?? []);
    return {
        active: settings ? isActive(settings) : false,
        byEmail,
        members: members.map((m) => {
            const email = m.user.email.toLowerCase();
            const excluded = excludedIds.has(m.id);
            const state: DelegationMemberState = ownConnection.has(m.id)
                ? 'own_connection'
                : !inAllowedDomains(email, domains)
                  ? 'outside_domains'
                  : excluded
                    ? 'excluded'
                    : 'delegated';
            const row = byEmail.get(email);
            return {
                id: m.id,
                name: m.user.displayName,
                email,
                excluded,
                state,
                delegated:
                    row?.credentialSource === 'delegation' && row.ownerMemberId === m.id
                        ? { id: row.id, status: row.status }
                        : null,
            };
        }),
    };
}

async function memberAddress(tx: WorkspaceClient, memberId: string): Promise<string> {
    const member = await tx.workspaceMember.findUniqueOrThrow({
        where: { id: memberId },
        select: { user: { select: { email: true } } },
    });
    return member.user.email.toLowerCase();
}

async function audit(
    tx: WorkspaceClient,
    workspaceId: string,
    action: DelegationAuditAction,
    entry: { actorMemberId?: string; subjectMemberId?: string; mailboxId?: string; detail?: Prisma.InputJsonObject },
): Promise<void> {
    await tx.googleWorkspaceDelegationAudit.create({
        data: {
            workspaceId,
            action,
            actorMemberId: entry.actorMemberId ?? null,
            subjectMemberId: entry.subjectMemberId ?? null,
            mailboxId: entry.mailboxId ?? null,
            detail: entry.detail ?? {},
        },
    });
}

function requireMember(context: WorkspaceRunContext): string {
    if (!context.memberId) {
        throw new ApiException(403, 'forbidden', 'Workspace delegation is set up by a member, not by an API key');
    }
    return context.memberId;
}

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((s) => b.includes(s));
}

function readCheck(value: Prisma.JsonValue): DelegationCheck {
    const stored = value as unknown as Omit<DelegationCheck, 'checkedAt'> & { checkedAt: string };
    return { ...stored, checkedAt: new Date(stored.checkedAt) };
}
