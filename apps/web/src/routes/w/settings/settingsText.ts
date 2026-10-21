import type { Capability, StageColour, StageKind, StageRuleEvent } from '@bylinecrm/shared';

/**
 * The settings screens' words (P1-UI-8), once: what a rule does in a sentence, what a reorder says
 * to a screen reader, a field's key from its label, and the people-facing name of every
 * capability. Pure functions, so the tests read them without rendering anything.
 */

/** What a rule's event means, finishing "When …". */
export const RULE_EVENT_PHRASE: Record<StageRuleEvent, string> = {
    'email.replied': 'a reply arrives',
    'meeting.booked': 'a meeting is booked',
    'email.clicked': 'a link is clicked',
    'invoice.verified': 'verified invoices cover the deal',
};

/** The event's name in a picker. */
export const RULE_EVENT_LABEL: Record<StageRuleEvent, string> = {
    'email.replied': 'A reply arrives',
    'meeting.booked': 'A meeting is booked',
    'email.clicked': 'A link is clicked',
    'invoice.verified': 'Verified invoices cover the deal',
};

/** "When a reply arrives, move the deal to Replied" — what a rule does, as a person says it. */
export function ruleSummary(event: StageRuleEvent, stageName: string, allowBackward: boolean): string {
    const base = `When ${RULE_EVENT_PHRASE[event]}, move the deal to ${stageName}`;
    return allowBackward ? `${base}, even if it is further along` : base;
}

export const STAGE_KIND_LABEL: Record<StageKind, string> = { open: 'Open', won: 'Won', lost: 'Lost' };

/** A stage colour's name in the picker; its tone comes from the board's one map (`STAGE_TONES`). */
export const STAGE_COLOUR_LABEL: Record<StageColour, string> = {
    neutral: 'Grey',
    accent: 'Violet',
    info: 'Blue',
    ok: 'Green',
    warn: 'Amber',
    bad: 'Red',
};

interface Named {
    id: string;
    name: string;
}

/**
 * The names the shared drag announcements (`makeDndAnnouncements`, packages/ui) speak while a stage
 * moves: the stage by its name, the place by its position — "Contacted over position 3 of 6" —
 * never an id (FR-CRMS-UI-8). The drop's outcome is spoken once by the reorder itself
 * (`stageMovedText`), so the helper's own "dropped in …" is turned off.
 */
export function stageReorderNames(stages: readonly Named[], announce: (text: string) => void) {
    const index = (id: string | number) => stages.findIndex((s) => s.id === String(id));
    return {
        itemName: (id: string | number) => stages[index(id)]?.name ?? 'Stage',
        containerName: (id: string | number) => `position ${index(id) + 1} of ${stages.length}`,
        isHome: (activeId: string | number, overId: string | number) => String(activeId) === String(overId),
        announceDrop: false,
        announce,
    };
}

/** What a finished reorder says, from the drag, its keyboard twin or the menu alike. */
export function stageMovedText(name: string, index: number, total: number): string {
    return `${name} moved to position ${index + 1} of ${total}.`;
}

/** "1 deal", "6,000 deals" — counts as a person reads them. */
export function dealCount(n: number): string {
    return `${n.toLocaleString('en-US')} ${n === 1 ? 'deal' : 'deals'}`;
}

/** The toast after a stage is deleted by moving its deals: "Moved 3 deals to Replied and deleted Contacted". */
export function movedDealsText(moved: number, toStage: string, deletedStage: string): string {
    return `Moved ${dealCount(moved)} to ${toStage} and deleted ${deletedStage}`;
}

/** The API's key grammar for a custom field: a lower-case letter, then letters, digits or `_`, 64 at most. */
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * A key from a label — "Last outlet" → `last_outlet`, "2026 budget" → `f_2026_budget` — so a
 * person names the field and the key follows; it can be edited once, before the field exists.
 */
export function fieldKeyFromLabel(label: string): string {
    const slug = label
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!slug) return '';
    const key = /^[a-z]/.test(slug) ? slug : `f_${slug}`;
    return key.slice(0, 64).replace(/_+$/, '');
}

/** The areas of the capability catalogue, as the roles editor groups them. */
export const CAPABILITY_AREA_LABEL: Record<string, string> = {
    record: 'Records',
    note: 'Notes',
    task: 'Tasks',
    deal: 'Deals',
    view: 'Views',
    pipeline: 'Pipelines',
    email: 'Email',
    template: 'Templates',
    outreach: 'Outreach',
    sequence: 'Sequences',
    mailbox: 'Mailboxes',
    guardrail: 'Guardrails',
    invoice: 'Invoices',
    workspace: 'Workspace',
};

/** What each capability lets a member do, as a label; the catalogue string is only a tooltip. */
export const CAPABILITY_LABEL: Record<Capability, string> = {
    'record:read': 'See people and companies',
    'record:write': 'Create and edit people and companies',
    'record:transfer': 'Move records between members without asking',
    'record:export_all': 'Export every record, not only their own',
    'note:write': 'Write notes',
    'task:write': 'Create and edit tasks',
    'deal:read': 'See deals',
    'deal:move': 'Move deals between stages',
    'deal:edit': 'Create and edit deals',
    'deal:bulk': 'Change many deals at once',
    'view:save': 'Save their own views',
    'view:share': 'Share views with the workspace',
    'pipeline:configure': 'Configure pipelines and stage rules',
    'pipeline:cadence': 'Set follow-up cadences and run the lead rotation',
    'email:send': 'Send email',
    'template:read': 'See email templates',
    'template:write': 'Create and edit email templates',
    'template:send_test': 'Send test emails',
    'outreach:write': 'Create outreach templates',
    'sequence:write': 'Build sequences',
    'sequence:enrol': 'Enrol people in sequences',
    'mailbox:read': 'See mailboxes',
    'mailbox:manage': 'Connect and manage mailboxes',
    'guardrail:review': 'Review guardrail events and hear of repeated blocks',
    'invoice:verify': 'Verify or refuse invoices by hand, and hear of ones waiting for finance',
    'workspace:admin': 'Administer the workspace',
};
