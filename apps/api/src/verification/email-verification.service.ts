import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
    EMAIL_VERIFICATION_DEFAULTS,
    isVerificationStale,
    type EmailVerificationReason,
    type EmailVerificationSettings,
    type EmailVerificationSettingsView,
    type EmailVerificationView,
    type Emails,
    type PersonVerificationView,
} from '@bylinecrm/shared';
import type { EmailVerification } from '@prisma/client';
import { StateConflict } from '../infra/errors/api-errors';
import { mapPool } from '../infra/map-pool';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { VERIFY_CONCURRENCY } from './verification.constants';
import { VERIFIER, type Verifier } from './verifier.port';

/**
 * Email verification (P3-5, FR-CRMS-14, FR-CRMS-16): the workspace's stored answer per address, found
 * again once it is older than the workspace's age (90 days unless set) or whenever it is `unknown`.
 *
 * `check` is the one read a decision is made from — the enrolment screen (P3-3) and the step runner
 * before every send. It reads what is stored in one short transaction, asks the verifier for what is
 * missing or stale with no transaction open (the verifier reaches DNS), writes the answers in
 * another, and returns every address asked for. A result is the address's, not a person's: two
 * people with one address share it, and an address that changes is simply a new one.
 */
@Injectable()
export class EmailVerificationService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        @Inject(VERIFIER) private readonly verifier: Verifier,
    ) {}

    /**
     * The current answer for each address (compared lower case), keyed by address. `force` finds
     * every one again, stored or not.
     */
    async check(
        workspaceId: string,
        addresses: readonly string[],
        options: { force?: boolean; now?: Date } = {},
    ): Promise<Map<string, EmailVerificationView>> {
        const now = options.now ?? new Date();
        const wanted = [...new Set(addresses.map(normalise).filter((a) => a.length > 0))];
        if (wanted.length === 0) return new Map();
        const { maxAgeDays, rows } = await this.rls.withWorkspace(workspaceId, async (tx) => ({
            maxAgeDays: (await this.settingsIn(tx)).maxAgeDays,
            rows: await tx.emailVerification.findMany({ where: { address: { in: wanted } } }),
        }));
        const stored = new Map(rows.map((row) => [row.address, row]));
        const toRun = wanted.filter((address) => {
            const row = stored.get(address);
            return options.force || !row || isVerificationStale(row, maxAgeDays, now);
        });
        if (toRun.length > 0) {
            // No transaction is open here: the verifier asks DNS.
            const answers = await mapPool(toRun, VERIFY_CONCURRENCY, (address) =>
                this.verifier.verify(address, { workspaceId }),
            );
            const verifiedAt = new Date();
            const written = await this.rls.withWorkspace(workspaceId, async (tx) => {
                const out: EmailVerification[] = [];
                for (const [i, address] of toRun.entries()) {
                    const answer = answers[i]!;
                    out.push(
                        await tx.emailVerification.upsert({
                            where: { workspaceId_address: { workspaceId, address } },
                            create: { workspaceId, address, ...answer, verifiedAt },
                            update: { ...answer, verifiedAt },
                        }),
                    );
                }
                return out;
            });
            for (const row of written) stored.set(row.address, row);
        }
        return new Map(wanted.map((address) => [address, view(stored.get(address)!, maxAgeDays, now)]));
    }

    // ── Settings (FR-CRMS-16) ───────────────────────────────────────────────────────────────

    settings(): Promise<EmailVerificationSettingsView> {
        this.current();
        return this.rls.withWorkspace((tx) => this.settingsViewIn(tx));
    }

    async putSettings(input: EmailVerificationSettings): Promise<EmailVerificationSettingsView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            await tx.emailVerificationSettings.upsert({
                where: { workspaceId: context.workspaceId },
                create: {
                    workspaceId: context.workspaceId,
                    maxAgeDays: input.maxAgeDays,
                    updatedByMemberId: context.memberId ?? null,
                },
                update: { maxAgeDays: input.maxAgeDays, updatedByMemberId: context.memberId ?? null },
            });
            return this.settingsViewIn(tx);
        });
    }

    /** The age in force, read in `tx`: the workspace's row, or the default. */
    async settingsIn(tx: WorkspaceClient): Promise<EmailVerificationSettings> {
        const row = await tx.emailVerificationSettings.findFirst();
        return row ? { maxAgeDays: row.maxAgeDays } : { ...EMAIL_VERIFICATION_DEFAULTS };
    }

    // ── A person's address ──────────────────────────────────────────────────────────────────

    /** The stored answer about the person's primary address, if there is one; never a lookup. */
    async forPerson(personId: string): Promise<PersonVerificationView> {
        const context = this.current();
        const address = await this.addressOf(personId);
        if (!address) return { address: null, verification: null };
        const { maxAgeDays, row } = await this.rls.withWorkspace(async (tx) => ({
            maxAgeDays: (await this.settingsIn(tx)).maxAgeDays,
            row: await tx.emailVerification.findUnique({
                where: { workspaceId_address: { workspaceId: context.workspaceId, address } },
            }),
        }));
        return { address, verification: row ? view(row, maxAgeDays, new Date()) : null };
    }

    /** Finds the person's primary address again now, fresh or not. */
    async verifyPerson(personId: string): Promise<EmailVerificationView> {
        const context = this.current();
        const address = await this.addressOf(personId);
        if (!address) throw new StateConflict('the person has no email address to verify');
        return (await this.check(context.workspaceId, [address], { force: true })).get(address)!;
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    private async settingsViewIn(tx: WorkspaceClient): Promise<EmailVerificationSettingsView> {
        const row = await tx.emailVerificationSettings.findFirst();
        return {
            maxAgeDays: row?.maxAgeDays ?? EMAIL_VERIFICATION_DEFAULTS.maxAgeDays,
            isDefault: !row || row.maxAgeDays === EMAIL_VERIFICATION_DEFAULTS.maxAgeDays,
            updatedAt: row?.updatedAt.toISOString() ?? null,
        };
    }

    /** The person's primary address in the caller's scope; `404` when they are not visible. */
    private async addressOf(personId: string): Promise<string | null> {
        const person = await this.rls.withWorkspace((tx) =>
            tx.person.findFirst({ where: { id: personId, deletedAt: null }, select: { emails: true } }),
        );
        if (!person) throw new NotFoundException('person not found');
        const primary = (person.emails as Emails | null)?.primary;
        return primary ? normalise(primary) || null : null;
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('EmailVerificationService is used inside a workspace scope');
        return context;
    }
}

function normalise(address: string): string {
    return address.trim().toLowerCase();
}

function view(row: EmailVerification, maxAgeDays: number, now: Date): EmailVerificationView {
    return {
        address: row.address,
        result: row.result,
        reason: row.reason as EmailVerificationReason,
        message: row.message,
        source: row.source,
        verifiedAt: row.verifiedAt.toISOString(),
        stale: isVerificationStale(row, maxAgeDays, now),
    };
}
