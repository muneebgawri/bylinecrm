import { Injectable, NotFoundException } from '@nestjs/common';
import type { GuardrailEventView, GuardrailSettingsView, MailboxCoverageView } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { requireCallerMember } from '../infra/caller-member';
import { StateConflict, UnknownReference } from '../infra/errors/api-errors';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { paginate, type Page } from '../records/list-query';
import type { ListGuardrailEventsQuery } from './dto';
import { guardrailSettings } from './guardrail-settings';
import { mailboxCoverage } from './mailbox-coverage';

const MEMBER = { select: { id: true, user: { select: { displayName: true } } } } as const;
const INCLUDE = { actor: MEMBER, owner: MEMBER, legitimateBy: MEMBER } as const;
type Row = Prisma.GuardrailEventGetPayload<{ include: typeof INCLUDE }>;

/**
 * The Guardrails page (GUARD-1, FR-CRMS-21): a reviewer (`guardrail:review`; managers and admins) reads what
 * the recipient guard did, narrows it, and marks an event legitimate with a reason — stored with who and when,
 * never deleted. The events themselves are written by `RecipientGuard`.
 */
@Injectable()
export class GuardrailsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    list(query: ListGuardrailEventsQuery): Promise<Page<GuardrailEventView>> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.guardrailEvent.findMany({
                    where: {
                        ...(query.kind ? { kind: query.kind } : {}),
                        ...(query.outcome ? { outcome: query.outcome } : {}),
                        ...(query.actorMemberId ? { actorMemberId: query.actorMemberId } : {}),
                        ...(query.reviewed === 'true' ? { legitimateAt: { not: null } } : {}),
                        ...(query.reviewed === 'false' ? { legitimateAt: null } : {}),
                    },
                    include: INCLUDE,
                    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                    ...args,
                }),
            );
            return { items: page.items.map(view), nextCursor: page.nextCursor };
        });
    }

    /** GUARD-2: who has no mailbox sync sees (the admin view). */
    mailboxCoverage(): Promise<MailboxCoverageView[]> {
        this.current();
        return this.rls.withWorkspace((tx) => mailboxCoverage(tx));
    }

    /** GUARD-2's settings (no row: the defaults). */
    settings(): Promise<GuardrailSettingsView> {
        this.current();
        return this.rls.withWorkspace((tx) => guardrailSettings(tx));
    }

    /** Admins: each shared mailbox must be an active member of this workspace. */
    async setSettings(input: GuardrailSettingsView): Promise<GuardrailSettingsView> {
        const { workspaceId } = this.current();
        const ids = [...new Set(input.sharedMailboxMemberIds)];
        return this.rls.withWorkspace(async (tx) => {
            const found = await tx.workspaceMember.count({ where: { id: { in: ids }, leftAt: null } });
            if (found !== ids.length)
                throw new UnknownReference('sharedMailboxMemberIds', 'every shared mailbox must be a member');
            const data = { poachEmailAtOnce: input.poachEmailAtOnce, sharedMailboxMemberIds: ids };
            const row = await tx.guardrailSettings.upsert({
                where: { workspaceId },
                create: { workspaceId, ...data },
                update: data,
            });
            return { poachEmailAtOnce: row.poachEmailAtOnce, sharedMailboxMemberIds: row.sharedMailboxMemberIds };
        });
    }

    /** Once: an event already marked is a `409`, so the first reviewer's reason stands. */
    async markLegitimate(id: string, reason: string): Promise<GuardrailEventView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const me = await requireCallerMember(tx, context);
            const changed = await tx.guardrailEvent.updateMany({
                where: { id, legitimateAt: null },
                data: { legitimateAt: new Date(), legitimateByMemberId: me, legitimateReason: reason },
            });
            const row = await tx.guardrailEvent.findUnique({ where: { id }, include: INCLUDE });
            if (!row) throw new NotFoundException('guardrail event not found');
            if (changed.count === 0) throw new StateConflict('this event is already marked legitimate');
            return view(row);
        });
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('GuardrailsService is used inside a workspace scope');
        return context;
    }
}

function named(m: { id: string; user: { displayName: string | null } } | null) {
    return m ? { memberId: m.id, name: m.user.displayName } : null;
}

function view(row: Row): GuardrailEventView {
    return {
        id: row.id,
        kind: row.kind,
        outcome: row.outcome,
        severity: row.severity,
        path: row.path,
        actor: named(row.actor),
        owner: named(row.owner),
        personId: row.personId,
        companyId: row.companyId,
        address: row.address,
        message: row.message,
        createdAt: row.createdAt.toISOString(),
        legitimate:
            row.legitimateAt && row.legitimateReason !== null
                ? { by: named(row.legitimateBy), reason: row.legitimateReason, at: row.legitimateAt.toISOString() }
                : null,
    };
}
