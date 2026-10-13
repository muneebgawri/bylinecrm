import { Injectable, Logger } from '@nestjs/common';
import { STAGE_RULE_EVENTS, type DomainEvent, type EventActor, type StageRuleEvent } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { storedRuleEvent } from './rule-events';
import { StageMoveService, type MoveOutcome } from './stage-move.service';

/**
 * The rule engine (FR-CRMS-9). When something a rule reacts to happens to a person or company,
 * the deals they are on move forward to the rule's stage — never backward unless the rule says
 * so, never twice for the same event (a deal already in or past the stage is left alone), and
 * never into a won or lost stage (rules cannot target one). It runs in the event's workspace
 * with no member and no owner scope, so a rule in one workspace cannot reach a deal in another:
 * the policies see only that workspace. Each move is attributed to the rule that made it.
 */
@Injectable()
@OutboxConsumerOf('stage-rules')
export class StageRulesService implements OutboxConsumer {
    private readonly log = new Logger(StageRulesService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly moves: StageMoveService,
    ) {}

    accepts(event: DomainEvent): boolean {
        return isRuleEvent(event.type);
    }

    /**
     * Idempotent without a key of its own: a redelivered event finds its deals already in the
     * rule's stage, and a deal in or past the stage is left alone.
     */
    async consume({ event }: DeliveredEvent): Promise<void> {
        await this.apply(event);
    }

    /** Applies every enabled rule for the event's type in its workspace; returns how many deals moved. */
    async apply(event: DomainEvent): Promise<number> {
        // An `email.opened` is never here: opens are indicative (FR-CRMS-8) and move nothing.
        if (!isRuleEvent(event.type)) return 0;
        const people = (event.related ?? []).filter((t) => t.type === 'person').map((t) => t.id);
        const companies = (event.related ?? []).filter((t) => t.type === 'company').map((t) => t.id);
        if (people.length === 0 && companies.length === 0) return 0;

        const moved = await this.rls.withWorkspace(event.workspaceId, async (tx) => {
            const rules = await tx.stageRule.findMany({
                where: { event: storedRuleEvent(event.type as StageRuleEvent), enabled: true },
            });
            const outcomes: {
                dealId: string;
                actor: EventActor;
                outcome: Extract<MoveOutcome, { outcome: 'moved' }>;
            }[] = [];
            for (const rule of rules) {
                // The move is the rule's: history and the timeline attribute it to the rule, not to the system.
                const actor: EventActor = { kind: 'rule', id: rule.id };
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
                    const outcome = await this.moves.move(tx, deal, rule.toStageId, actor, {
                        reason: 'rule',
                        allowBackward: rule.allowBackward,
                    });
                    if (outcome.outcome === 'moved') {
                        await this.moves.announce(tx, event.workspaceId, deal.id, actor, outcome);
                        outcomes.push({ dealId: deal.id, actor, outcome });
                    }
                }
            }
            return outcomes;
        });
        if (moved.length) this.log.log(`${event.type}: ${moved.length} deal(s) moved by rule in ${event.workspaceId}`);
        return moved.length;
    }
}

function isRuleEvent(type: DomainEvent['type']): type is StageRuleEvent {
    return (STAGE_RULE_EVENTS as readonly string[]).includes(type);
}
