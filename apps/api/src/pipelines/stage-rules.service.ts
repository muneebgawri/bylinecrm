import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { DomainEvent, StageRuleEvent } from '@bylinecrm/shared';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { storedRuleEvent } from './rule-events';
import { StageMoveService, type MoveOutcome } from './stage-move.service';

/** The system, acting on a rule: no member, no key. */
const RULE_ACTOR = { kind: 'system', id: null } as const;

/**
 * The rule engine (FR-CRMS-9). When something a rule reacts to happens to a person or company,
 * the deals they are on move forward to the rule's stage — never backward unless the rule says
 * so, never twice for the same event (a deal already in or past the stage is left alone), and
 * never into a won or lost stage (rules cannot target one). It runs as the system in the
 * event's workspace, so a rule in one workspace cannot reach a deal in another: the policies
 * see only that workspace.
 */
@Injectable()
export class StageRulesService {
    private readonly log = new Logger(StageRulesService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly moves: StageMoveService,
    ) {}

    @OnEvent('email.replied', { async: true, promisify: true })
    onEmailReplied(event: DomainEvent): Promise<number> {
        return this.apply(event);
    }

    @OnEvent('meeting.booked', { async: true, promisify: true })
    onMeetingBooked(event: DomainEvent): Promise<number> {
        return this.apply(event);
    }

    /** Applies every enabled rule for the event's type in its workspace; returns how many deals moved. */
    async apply(event: DomainEvent): Promise<number> {
        if (event.type !== 'email.replied' && event.type !== 'meeting.booked') return 0;
        const people = (event.related ?? []).filter((t) => t.type === 'person').map((t) => t.id);
        const companies = (event.related ?? []).filter((t) => t.type === 'company').map((t) => t.id);
        if (people.length === 0 && companies.length === 0) return 0;

        const moved = await this.rls.withWorkspace(event.workspaceId, async (tx) => {
            const rules = await tx.stageRule.findMany({
                where: { event: storedRuleEvent(event.type as StageRuleEvent), enabled: true },
            });
            const outcomes: { dealId: string; outcome: Extract<MoveOutcome, { outcome: 'moved' }> }[] = [];
            for (const rule of rules) {
                const deals = await tx.opportunity.findMany({
                    where: {
                        pipelineId: rule.pipelineId,
                        deletedAt: null,
                        stage: { kind: 'open' },
                        OR: [
                            ...(people.length ? [{ pointOfContactId: { in: people } }] : []),
                            ...(companies.length ? [{ companyId: { in: companies } }] : []),
                        ],
                    },
                    select: { id: true, workspaceId: true, pipelineId: true, stageId: true },
                });
                for (const deal of deals) {
                    const outcome = await this.moves.move(tx, deal, rule.toStageId, RULE_ACTOR, {
                        reason: 'rule',
                        allowBackward: rule.allowBackward,
                    });
                    if (outcome.outcome === 'moved') outcomes.push({ dealId: deal.id, outcome });
                }
            }
            return outcomes;
        });
        for (const { dealId, outcome } of moved) this.moves.announce(event.workspaceId, dealId, RULE_ACTOR, outcome);
        if (moved.length) this.log.log(`${event.type}: ${moved.length} deal(s) moved by rule in ${event.workspaceId}`);
        return moved.length;
    }
}
