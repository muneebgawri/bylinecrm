import type { BadgeProps } from '@bylinecrm/ui';
import type { EnrolmentStatus, EnrolmentStopReason, SequenceStatus, SequenceWindow } from '../../../api/types';

/** One wording for each sequence state, everywhere it is shown (doc 50 §D). */
export const SEQUENCE_STATUS_LABEL: Record<SequenceStatus, string> = {
    draft: 'Draft',
    active: 'Active',
    paused: 'Paused',
    archived: 'Archived',
};

export const SEQUENCE_STATUS_TONE: Record<SequenceStatus, NonNullable<BadgeProps['status']>> = {
    draft: 'neutral',
    active: 'success',
    paused: 'warning',
    archived: 'neutral',
};

export const ENROLMENT_STATUS_LABEL: Record<EnrolmentStatus, string> = {
    active: 'Active',
    held: 'Held',
    finished: 'Finished',
    stopped: 'Stopped',
};

export const ENROLMENT_STATUS_TONE: Record<EnrolmentStatus, NonNullable<BadgeProps['status']>> = {
    active: 'success',
    held: 'warning',
    finished: 'neutral',
    stopped: 'danger',
};

/** Why an enrolment stopped, as a member reads it. */
export const STOP_REASON_LABEL: Record<EnrolmentStopReason, string> = {
    reply: 'reply received',
    bounce: 'hard bounce',
    unsubscribe: 'unsubscribed',
    complaint: 'spam complaint',
    suppressed: 'suppression hit',
    manual: 'stopped by a member',
    pipeline_exit: 'deal left the pipeline',
    excluded: 'excluded (customer or account-managed)',
    sequence_archived: 'sequence archived',
    person_deleted: 'person deleted',
};

/**
 * The stop conditions every sequence has (doc 50 §D). They are shown so a member can see them, not
 * choose them: the server refuses turning any of them off. "Deal leaves pipeline" is the one setting.
 */
export const MANDATORY_STOPS = [
    'Reply received',
    'Hard bounce',
    'Unsubscribe',
    'Spam complaint',
    'Suppression hit',
    'Stopped by a member',
] as const;

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const DAYS = DAY_NAMES.map((name, bit) => ({ name, bit }));

/** Minutes after midnight as `HH:MM`; the window's end may be 1440, shown as 24:00. */
export function minuteToTime(minute: number): string {
    const m = Math.max(0, Math.min(minute, 1440));
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** What a time input can hold: 24:00 is not a time of day, so an end of midnight edits as 23:59. */
export function minuteToInput(minute: number): string {
    return minuteToTime(Math.min(minute, 1439));
}

export function timeToMinute(value: string): number | null {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
}

/** "09:00–17:00 · Mon–Fri" — the window as one line. */
export function describeWindow(window: SequenceWindow): string {
    const days = DAYS.filter((d) => window.days & (1 << d.bit)).map((d) => d.name);
    const weekdays = window.days === 0b0011111;
    return `${minuteToTime(window.startMinute)}–${minuteToTime(window.endMinute)} · ${weekdays ? 'Mon–Fri' : days.join(', ')}`;
}
