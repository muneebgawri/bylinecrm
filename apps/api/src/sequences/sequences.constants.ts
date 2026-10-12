/** The queue a due enrolment's step runs on (P3-3): one delayed job per due step. */
export const SEQUENCE_STEP_QUEUE = 'sequence-steps';

/** The repeating sweep that re-adds lost step jobs and re-delivers missed step outcomes. */
export const SEQUENCE_MAINTENANCE_QUEUE = 'sequence-maintenance';
export const SEQUENCE_SWEEP_EVERY_MS = 60_000;
/** A pass re-adds jobs for steps due before the next two passes. */
export const SEQUENCE_SWEEP_HORIZON_MS = 2 * SEQUENCE_SWEEP_EVERY_MS;
export const SEQUENCE_SWEEP_BATCH = 500;
/** Rows examined per sweep pass at most, per query (#97); the next pass resumes where this one stopped. */
export const SEQUENCE_SWEEP_MAX_ROWS_PER_PASS = 10 * SEQUENCE_SWEEP_BATCH;
/** A step whose send has finished but whose enrolment still waits this long has missed its outcome. */
export const SEQUENCE_OUTCOME_GRACE_MS = 2 * 60_000;

export const SEQUENCE_STEP_ATTEMPTS = 5;
export const SEQUENCE_STEP_BACKOFF_MS = 10_000;
export const SEQUENCE_WORKER_CONCURRENCY = 4;

/**
 * When the pool has no mailbox that can send (every one capped, paused or unverified), the step is
 * tried again this much later — inside the window — rather than dropped. Allowances roll over 24
 * hours, so capacity frees up through the day.
 */
export const SEQUENCE_POOL_RETRY_MS = 60 * 60_000;

/**
 * When the address cannot be verified before an email step (DNS did not answer — FR-CRMS-14), the
 * step is tried again this much later; it is never sent unverified and never dropped.
 */
export const SEQUENCE_VERIFY_RETRY_MS = 15 * 60_000;

/** Failure codes that mean "the pool could not send it now": the step is rescheduled, not held. */
export const RESCHEDULE_FAILURE_CODES: ReadonlySet<string> = new Set([
    'mailbox.cap_reached',
    'mailbox.paused',
    'mailbox.domain_unverified',
    'mailbox.disconnected',
    'mailbox.reconnect_needed',
]);
