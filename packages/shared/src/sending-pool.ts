import type { MailboxStatus } from './mail.js';

/**
 * The sending pool (P3-2, FR-CRMS-6, FR-CRMS-13): what the API, the web app and the tests share.
 * Why each default is what it is: docs/design-notes/P3-2.md.
 */

/** A workspace's pool settings. Rates are in basis points (1/100 of a percent): 500 = 5%. */
export interface SendingPoolSettings {
    dailyCap: number;
    warmupStartPerDay: number;
    warmupDays: number;
    jitterMinSeconds: number;
    jitterMaxSeconds: number;
    bouncePauseBps: number;
    complaintPauseBps: number;
    rateMinSample: number;
    rateWindowDays: number;
}

/** The defaults a workspace starts with — the same values as the database's column defaults. */
export const SENDING_POOL_DEFAULTS: Readonly<SendingPoolSettings> = {
    dailyCap: 40,
    warmupStartPerDay: 5,
    warmupDays: 21,
    jitterMinSeconds: 60,
    jitterMaxSeconds: 300,
    bouncePauseBps: 500,
    complaintPauseBps: 20,
    rateMinSample: 20,
    rateWindowDays: 7,
};

/** The bounds each setting is validated against (the database checks the same). */
export const SENDING_POOL_LIMITS = {
    dailyCap: { min: 1, max: 500 },
    warmupDays: { min: 1, max: 90 },
    jitterSeconds: { min: 0, max: 3600 },
    rateBps: { min: 1, max: 10_000 },
    rateMinSample: { min: 1, max: 10_000 },
    rateWindowDays: { min: 1, max: 90 },
} as const;

/** The allowance is over this rolling window — Gmail's own sending limits are rolling, not calendar days. */
export const SENDING_POOL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How often every sending domain's DNS is checked again (FR-CRMS-13). */
export const SENDING_DOMAIN_RECHECK_MS = 6 * 60 * 60 * 1000;

/** The DKIM selector checked when none is set: Google Workspace's default. */
export const DEFAULT_DKIM_SELECTOR = 'google';

/**
 * The most a mailbox may send on warm-up day `day` (1 = the day it first connected): `start` a day,
 * rising evenly to `cap` on day `days`, and `cap` from then on.
 */
export function warmupLimit(cap: number, start: number, days: number, day: number): number {
    if (days <= 1 || day >= days) return cap;
    const first = Math.min(start, cap);
    const d = Math.max(1, Math.floor(day));
    return Math.min(cap, first + Math.floor(((cap - first) * (d - 1)) / (days - 1)));
}

/** The warm-up day a moment falls on, counted from the mailbox's first connection (day 1). */
export function warmupDay(startedAt: Date, now: Date): number {
    return Math.floor((now.getTime() - startedAt.getTime()) / SENDING_POOL_WINDOW_MS) + 1;
}

/** Why a mailbox was paused: the rate that crossed its threshold. */
export const MAILBOX_PAUSE_CODES = ['bounce_rate', 'complaint_rate'] as const;
export type MailboxPauseCode = (typeof MAILBOX_PAUSE_CODES)[number];

export interface MailboxPause {
    code: MailboxPauseCode;
    message: string;
    /** Basis points, over the window, when the pause was decided. */
    rateBps: number;
    thresholdBps: number;
    /** Sends in the window the rate was measured over. */
    sends: number;
    /** ISO 8601. */
    at: string;
}

/** What `email.bounced` says (P3-2): which address failed, how, from which mailbox, for which send. */
export interface EmailBounce {
    mailboxId: string;
    address: string;
    permanent: boolean;
    status: string | null;
    outboundId: string | null;
}

/** One DNS check's outcome for one step. */
export interface DomainCheckStep {
    outcome: 'pass' | 'fail';
    message: string;
}

export interface DomainCheck {
    spf: DomainCheckStep;
    dkim: DomainCheckStep;
    dmarc: DomainCheckStep;
}

export type SendingDomainStatus = 'unchecked' | 'pass' | 'fail';

export interface SendingDomainView {
    id: string;
    domain: string;
    dkimSelector: string;
    status: SendingDomainStatus;
    lastCheck: DomainCheck | null;
    checkedAt: string | null;
    nextCheckAt: string;
}

/** One pool mailbox's health, as `GET /sending-pool` reports it. */
export interface PoolMailboxHealth {
    mailboxId: string;
    email: string;
    status: MailboxStatus;
    /** The mailbox's own cap, or null when it takes the workspace's. */
    dailyCapOverride: number | null;
    /** The cap that applies (its own, or the workspace's). */
    dailyCap: number;
    warmupDay: number | null;
    /** The warm-up limit today, which is the cap once warm-up is over. */
    warmupLimit: number;
    /** min(cap, warm-up limit): the most it may send in the rolling 24 hours. */
    allowance: number;
    /** Sends that went or are going in the last 24 hours. */
    used: number;
    paused: MailboxPause | null;
    domain: SendingDomainView | null;
    /** Whether a send from it would pass the gate right now. */
    canSend: boolean;
}

export interface SendingPoolView {
    settings: SendingPoolSettings;
    mailboxes: PoolMailboxHealth[];
    domains: SendingDomainView[];
}
