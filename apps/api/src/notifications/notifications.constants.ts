/**
 * Every fixed number task notifications (#192) run on. Why each is what it is:
 * docs/design-notes/NOTIFY-1.md.
 */

/** The queue the repeating notification jobs run on, and their names. */
export const NOTIFICATIONS_MAINTENANCE_QUEUE = 'notifications-maintenance';
export const TASK_DUE_JOB = 'task-due';
export const TASK_DIGEST_JOB = 'task-digest';

/** How often tasks that came due are looked for. */
export const TASK_DUE_EVERY_MS = 15 * 60 * 1000;
/** Tasks reminded in one pass, the longest due first. */
export const TASK_DUE_BATCH = 500;
/**
 * A task due within this long of being made was due as it was made (a sequence's task step is due
 * "now"): being assigned it is the reminder, so no second one.
 */
export const TASK_DUE_AS_MADE_MS = 60 * 1000;
/** Only tasks that came due this recently are reminded: an old backlog is not announced all at once. */
export const TASK_DUE_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * When the morning digest goes: 03:00 UTC every day — 08:00 in Pakistan (PKT, UTC+5), where the
 * account managers work. Members have no time zone of their own yet.
 */
export const TASK_DIGEST_CRON = '0 3 * * *';

/** The most open tasks My tasks and a digest list. */
export const MY_TASKS_LIMIT = 200;
