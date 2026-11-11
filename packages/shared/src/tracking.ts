import type { SendingDomainStatus } from './sending-pool.js';

/**
 * Tracking (P3-4, FR-CRMS-8): clicks through a workspace's short-link domain, and opens from a
 * pixel that are *indicative* only — mail clients and security gateways fetch images and links
 * without a person reading anything. Design: docs/design-notes/P3-4.md.
 */

/** The short-link domain's state: the same vocabulary as a sending domain's DNS check. */
export type TrackingDomainStatus = SendingDomainStatus;

export interface TrackingDomainCheck {
    outcome: 'pass' | 'fail';
    message: string;
}

/** A workspace's short-link domain as set. */
export interface TrackingDomainView {
    /** Lower case: the host tracked links and pixels are served from. */
    domain: string;
    /** Links are rewritten only while `pass`. */
    status: TrackingDomainStatus;
    lastCheck: TrackingDomainCheck | null;
    checkedAt: string | null;
    updatedAt: string;
}

/** What `GET /tracking/domain` (and every change to it) answers: the record to publish, and the domain if one is set. */
export interface TrackingSettingsView {
    /** The host the domain's CNAME must point at: the API. Known before any domain is set. */
    cnameTarget: string;
    /** `null` while none is set: links go out untracked. */
    domain: TrackingDomainView | null;
}

/** What is counted on a send and on a sequence step; `opens` is indicative. */
export interface TrackingCounts {
    clicks: number;
    /** Distinct links clicked at least once. */
    uniqueClicks: number;
    /** Indicative: a client's prefetch counts the same as a person's read. */
    opens: number;
}

export const NO_TRACKING_COUNTS: Readonly<TrackingCounts> = Object.freeze({ clicks: 0, uniqueClicks: 0, opens: 0 });

/**
 * Why a hit is a scanner's, not a person's: a known scanner's or fetch library's user agent, or any
 * hit within `TRACKING_BOT_WINDOW_MS` of delivery (a security gateway follows every link as the
 * mail arrives). Such a hit is kept with its reason and counted nowhere.
 */
export const TRACKING_BOT_REASONS = ['scanner_user_agent', 'too_soon_after_delivery'] as const;
export type TrackingBotReason = (typeof TRACKING_BOT_REASONS)[number];
export const TRACKING_BOT_WINDOW_MS = 2_000;

/** The public routes on the short-link domain: `https://<domain>/r/<token>` redirects, `/o/<token>` is the pixel. */
export const TRACKING_CLICK_PATH = 'r';
export const TRACKING_OPEN_PATH = 'o';

/** What `email.clicked` and `email.opened` carry: the send, the person, the link, and the step it was. */
export interface EmailTrackingPayload {
    outboundId: string;
    personId: string | null;
    /** The link's original URL; null for an open. */
    url: string | null;
    sequenceStepId: string | null;
    enrolmentId: string | null;
    /** True for an open: the event says a client fetched the image, not that a person read the mail. */
    indicative: boolean;
}

/** TRACK-2: who tracks opens and clicks: our own short links and pixel, or SMTP2Go's tracking. */
export const TRACKING_PROVIDERS = ['builtin', 'smtp2go'] as const;
export type TrackingProvider = (typeof TRACKING_PROVIDERS)[number];

/** TRACK-2: how the workspace tracks its mail (`GET /tracking/policy`); an admin changes it. */
export interface TrackingPolicyView {
    provider: TrackingProvider;
    trackOpens: boolean;
    trackClicks: boolean;
    /** Whether an email written in the CRM is tracked unless its writer turns it off. */
    trackPersonalMail: boolean;
    /** Whether a member hears of a CRM contact's reply to an email they sent straight from Gmail. */
    gmailReplyNotices: boolean;
    smtp2go: {
        /** An API key is set (it is never shown). */
        keySet: boolean;
        /** Where SMTP2Go's webhook for CRM-written mail posts to. */
        hookUrl: string;
        /** The `Authorization` header SMTP2Go must send; null until a key is set. */
        hookAuthorization: string | null;
        lastHookAt: string | null;
        lastHookResult: string | null;
    };
    /**
     * Personal mailboxes whose grant cannot keep a copy in Gmail's Sent: with SMTP2Go chosen, their CRM-written mail
     * still goes through Gmail (tracked by our own links) until they are connected again.
     */
    mailboxesWithoutCopy: { id: string; email: string }[];
}
