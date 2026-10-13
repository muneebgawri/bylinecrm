import { TRACKING_BOT_WINDOW_MS, type TrackingBotReason } from '@bylinecrm/shared';

/**
 * Bot filtering (P3-4, FR-CRMS-8). A hit is a scanner's, and counted nowhere, when its user agent
 * is a known link scanner's or a fetch library's (or empty — no mail client sends none), or when it
 * comes within 2 s of delivery: a security gateway follows every link as the mail arrives, long
 * before a person could. A mail client's image proxy (Gmail's GoogleImageProxy) is let through: it
 * fetches when the person opens the mail, which is what an *indicative* open means. The rule is
 * stated in docs/design-notes/P3-4.md; changing it is changing that note.
 */
const SCANNER_MARKS = [
    'barracuda',
    'proofpoint',
    'mimecast',
    'urldefense',
    'safelinks',
    'forcepoint',
    'symantec',
    'trendmicro',
    'sophos',
    'fireeye',
    'zscaler',
    'bitdefender',
    'curl/',
    'wget/',
    'python-requests',
    'python-urllib',
    'go-http-client',
    'java/',
    'okhttp',
    'libwww-perl',
    'httpclient',
    'axios/',
    'node-fetch',
    'headlesschrome',
    'phantomjs',
    'bot',
    'spider',
    'crawler',
    'linkexpanding',
    'preview',
    'validator',
];

/** Whether the user agent is a known scanner's or fetch library's, or missing. */
export function isScannerUserAgent(userAgent: string | undefined): boolean {
    const ua = (userAgent ?? '').trim().toLowerCase();
    if (ua === '') return true;
    return SCANNER_MARKS.some((mark) => ua.includes(mark));
}

/** Why the hit is a bot's, or `null` for a person's. */
export function botReason(hit: {
    userAgent: string | undefined;
    sentAt: Date | null;
    at: Date;
}): TrackingBotReason | null {
    if (isScannerUserAgent(hit.userAgent)) return 'scanner_user_agent';
    if (hit.sentAt && hit.at.getTime() - hit.sentAt.getTime() <= TRACKING_BOT_WINDOW_MS)
        return 'too_soon_after_delivery';
    return null;
}
