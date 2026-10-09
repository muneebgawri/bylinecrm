import type { StageRuleEvent } from '@bylinecrm/shared';
import type { StageRuleEvent as StoredRuleEvent } from '@prisma/client';

/**
 * A rule's event is spelled `email.replied` everywhere a person sees it (the event catalogue, the
 * API) and `email_replied` in the generated client, whose enum members cannot contain a dot; the
 * database stores the dotted spelling. One place translates.
 */
export function storedRuleEvent(event: StageRuleEvent): StoredRuleEvent {
    return event.replace('.', '_') as StoredRuleEvent;
}

export function ruleEventOf(stored: StoredRuleEvent): StageRuleEvent {
    return stored.replace('_', '.') as StageRuleEvent;
}
