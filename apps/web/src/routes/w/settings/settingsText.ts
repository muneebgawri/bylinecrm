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
};

/** The event's name in a picker. */
export const RULE_EVENT_LABEL: Record<StageRuleEvent, string> = {
    'email.replied': 'A reply arrives',
    'meeting.booked': 'A meeting is booked',
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

/** "Contacted, position 2 of 5" — how a stage is named while it moves; never by its id. */
function at(name: string, index: number, total: number): string {
    return `${name}, position ${index + 1} of ${total}`;
}

interface Named {
    id: string;
    name: string;
}

/**
 * dnd-kit's screen-reader announcements for the stage list, written for stages (FR-CRMS-UI-8). The
 * library's defaults read the dragged and target ids aloud — UUIDs — which is what the exit check
 * found on the board; here every message names the stage and its position.
 */
export function stageReorderAnnouncements(stages: readonly Named[]) {
    const index = (id: string | number) => stages.findIndex((s) => s.id === String(id));
    const name = (id: string | number) => stages[index(id)]?.name ?? 'Stage';
    const total = stages.length;
    return {
        onDragStart: ({ active }: { active: { id: string | number } }) =>
            `Picked up ${at(name(active.id), index(active.id), total)}. Use the arrow keys to move it, Space to drop, Escape to cancel.`,
        onDragOver: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) =>
            over
                ? `${name(active.id)} is over position ${index(over.id) + 1} of ${total}.`
                : `${name(active.id)} is not over a position.`,
        onDragEnd: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) =>
            over
                ? `${name(active.id)} dropped at position ${index(over.id) + 1} of ${total}.`
                : `${name(active.id)} dropped where it started.`,
        onDragCancel: ({ active }: { active: { id: string | number } }) =>
            `Reorder cancelled. ${at(name(active.id), index(active.id), total)}.`,
    };
}

/** The instructions a screen reader hears on a draggable stage, before anything moves. */
export const STAGE_REORDER_INSTRUCTIONS =
    'To reorder, press Space to pick up the stage, the arrow keys to move it, and Space again to drop it. Escape cancels.';

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
    workspace: 'Workspace',
};

/** What each capability lets a member do, as a label; the catalogue string is only a tooltip. */
export const CAPABILITY_LABEL: Record<Capability, string> = {
    'record:read': 'See people and companies',
    'record:write': 'Create and edit people and companies',
    'note:write': 'Write notes',
    'task:write': 'Create and edit tasks',
    'deal:read': 'See deals',
    'deal:move': 'Move deals between stages',
    'deal:edit': 'Create and edit deals',
    'deal:bulk': 'Change many deals at once',
    'view:save': 'Save their own views',
    'view:share': 'Share views with the workspace',
    'pipeline:configure': 'Configure pipelines and stage rules',
    'email:send': 'Send email',
    'template:read': 'See email templates',
    'template:write': 'Create and edit email templates',
    'template:send_test': 'Send test emails',
    'outreach:write': 'Create outreach templates',
    'sequence:write': 'Build sequences',
    'sequence:enrol': 'Enrol people in sequences',
    'mailbox:read': 'See mailboxes',
    'mailbox:manage': 'Connect and manage mailboxes',
    'workspace:admin': 'Administer the workspace',
};
