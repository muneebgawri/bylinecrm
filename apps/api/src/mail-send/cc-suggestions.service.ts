import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { RecipientGuard, type GuardVerdict } from '../guardrails/recipient-guard';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { recordWhere } from '../records/record-scope';
import { personName } from '../records/summaries';
import { MAIL_CC_SUGGESTIONS_MAX } from './mail-send.constants';
import type { MailCcSuggestions } from './responses';

/** A colleague as the database hands them over: the columns the suggestion is made from. */
export interface CcCandidate {
    id: string;
    nameFirst: string;
    nameLast: string;
    emailPrimary: string | null;
    jobTitle: string | null;
    lastContactedAt: Date | null;
    companyId: string | null;
    company: { id: string; name: string; deletedAt: Date | null } | null;
}

const CANDIDATE_SELECT = {
    id: true,
    nameFirst: true,
    nameLast: true,
    emailPrimary: true,
    jobTitle: true,
    lastContactedAt: true,
    companyId: true,
    company: { select: { id: true, name: true, deletedAt: true } },
} as const;

/**
 * Suggested Cc for the composer: when an account manager writes to one person at a company, the other people
 * there are offered as Cc — offered, never added. The candidates are the live people at the To recipients'
 * companies, inside the caller's record scope, with a primary address, less the recipients themselves; each is
 * then judged as a send would judge them — the suppression list (so `do_not_contact`) and the recipient guard
 * (GUARD-1: pooled customers, exclusions, another member's lead), asked quietly — and the blocked are left out.
 * One mechanism per concern: the guard is the same `RecipientGuard` every send passes, so what the row offers,
 * Send accepts.
 */
@Injectable()
export class CcSuggestionsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly guard: RecipientGuard,
    ) {}

    async suggest(personIds: readonly string[]): Promise<MailCcSuggestions> {
        const context = this.current();
        const recipients = new Set(personIds);
        const { companyIds, candidates } = await this.rls.withWorkspace(async (tx) => {
            const live = recordWhere(context, false) as Prisma.PersonWhereInput;
            const toPeople = await tx.person.findMany({
                where: { ...live, id: { in: [...recipients] }, companyId: { not: null } },
                select: { id: true, companyId: true },
            });
            // The To line's order: the first recipient's company first.
            const companyIds: string[] = [];
            for (const id of personIds) {
                const companyId = toPeople.find((p) => p.id === id)?.companyId;
                if (companyId && !companyIds.includes(companyId)) companyIds.push(companyId);
            }
            if (companyIds.length === 0) return { companyIds, candidates: [] as CcCandidate[] };
            const candidates = await tx.person.findMany({
                where: {
                    ...live,
                    companyId: { in: companyIds },
                    id: { notIn: [...recipients] },
                    emailPrimary: { not: null },
                },
                select: CANDIDATE_SELECT,
                orderBy: [
                    { lastContactedAt: { sort: 'desc', nulls: 'last' } },
                    { jobTitle: { sort: 'asc', nulls: 'last' } },
                    { nameLast: 'asc' },
                    { nameFirst: 'asc' },
                    { id: 'asc' },
                ],
                // Read a few more than offered: some are refused by the guard.
                take: MAIL_CC_SUGGESTIONS_MAX * 2,
            });
            return { companyIds, candidates };
        });
        if (candidates.length === 0) return { groups: [] };
        // Judged as a send would judge them, without an audit row: a suggestion is not an attempt.
        const verdicts = await this.guard.check({
            path: 'send',
            outreach: false,
            replyToMessageId: null,
            record: false,
            recipients: candidates.map((c) => ({ address: c.emailPrimary ?? '', personId: c.id, field: 'cc' })),
        });
        return groupSuggestions(companyIds, candidates, verdicts, MAIL_CC_SUGGESTIONS_MAX);
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('CcSuggestionsService is used inside a workspace scope');
        return context;
    }
}

/**
 * The candidates the guard lets through, grouped by company in `companyIds` order, keeping the database's order
 * within a group (last contacted first), at most `max` in all. A candidate whose company is in the trash, or
 * whose address the guard blocked, is left out.
 */
export function groupSuggestions(
    companyIds: readonly string[],
    candidates: readonly CcCandidate[],
    verdicts: readonly GuardVerdict[],
    max: number,
): MailCcSuggestions {
    const blocked = new Set(verdicts.filter((v) => v.outcome === 'blocked').map((v) => v.personId ?? v.address));
    const groups: MailCcSuggestions['groups'] = [];
    let offered = 0;
    for (const companyId of companyIds) {
        const company = candidates.find((c) => c.companyId === companyId)?.company;
        if (!company || company.deletedAt !== null) continue;
        const people: MailCcSuggestions['groups'][number]['people'] = [];
        for (const c of candidates) {
            if (offered >= max) break;
            if (c.companyId !== companyId || !c.emailPrimary) continue;
            if (blocked.has(c.id) || blocked.has(c.emailPrimary.toLowerCase())) continue;
            people.push({
                id: c.id,
                name: personName(c.nameFirst, c.nameLast, c.emailPrimary),
                email: c.emailPrimary,
                jobTitle: c.jobTitle,
                lastContactedAt: c.lastContactedAt,
            });
            offered += 1;
        }
        if (people.length > 0) groups.push({ company: { id: company.id, name: company.name }, people });
    }
    return { groups };
}
