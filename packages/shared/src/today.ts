/**
 * Today (#360): one member's work for the day, in five sections — the replies waiting for them, the deals whose
 * follow-up is due, the new leads nobody has contacted, the tasks due, and the deals gone quiet. Each section is
 * counted (up to `LIST_COUNT_CAP`) and read a page at a time, most urgent first, so a legacy backlog of tens of
 * thousands of rows costs the same as a handful.
 */

export const TODAY_SECTIONS = ['replies', 'followUps', 'newLeads', 'tasks', 'stalled'] as const;
export type TodaySection = (typeof TODAY_SECTIONS)[number];

/** Each section's URL segment under `GET …/today/`. */
export const TODAY_SECTION_PATHS: Readonly<Record<TodaySection, string>> = {
    replies: 'replies',
    followUps: 'follow-ups',
    newLeads: 'new-leads',
    tasks: 'tasks',
    stalled: 'stalled',
};

/** Rows per section on one read. */
export const TODAY_LIMIT_DEFAULT = 10;
export const TODAY_LIMIT_MAX = 50;

/** A reply older than this is history, not something waiting: the section looks back this far. */
export const TODAY_REPLY_WINDOW_DAYS = 30;

/** A person made in the last this many days, never contacted, is a new lead. */
export const TODAY_NEW_LEAD_DAYS = 14;

/** An open deal with no touch (CADENCE-1's), stage move or creation for this many days, and nothing planned, is stalled. */
export const TODAY_STALLED_DAYS = 21;
