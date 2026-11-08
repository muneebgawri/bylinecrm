/**
 * Calls (CALL-1): a phone call between a member and a person, placed or taken in Quo (formerly OpenPhone) and
 * reported to the CRM by Quo's webhooks, or logged by hand from the record's Call panel. Quo cannot place a call
 * through its API, so the CRM opens the number in the Quo app (`tel:`) and keeps the log, the notes and the
 * outcome; the recording, the AI summary and the transcript arrive from Quo once it has them.
 */

export const CALL_DIRECTIONS = ['outbound', 'inbound'] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

/** What became of the call, as the provider reports it; `logged` is a call written down by hand. */
export const CALL_STATUSES = ['answered', 'missed', 'voicemail', 'unanswered', 'logged'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/** The outcome the member records in the Call panel (Salesloft's dispositions, the ones a rep needs). */
export const CALL_DISPOSITIONS = [
    'connected',
    'voicemail',
    'no_answer',
    'busy',
    'wrong_number',
    'callback',
    'not_interested',
] as const;
export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

export const CALL_DISPOSITION_LABELS: Readonly<Record<CallDisposition, string>> = {
    connected: 'Connected',
    voicemail: 'Left voicemail',
    no_answer: 'No answer',
    busy: 'Busy',
    wrong_number: 'Wrong number',
    callback: 'Call back later',
    not_interested: 'Not interested',
};

/** Where a call came from: Quo's webhooks, or a member's own log. */
export const CALL_PROVIDERS = ['quo', 'manual'] as const;
export type CallProvider = (typeof CALL_PROVIDERS)[number];

/**
 * A call logged by hand is matched to the Quo call that follows it when Quo reports one to the same number
 * that started within this long of the log: the member clicked Call, spoke, wrote the outcome; Quo's report
 * then brings the duration and the recording to the same row.
 */
export const CALL_MATCH_WINDOW_MS = 30 * 60 * 1000;

/** A recording Quo made of the call, as the timeline and the record show it. */
export interface CallRecording {
    url: string;
    durationSec: number | null;
}

/** Quo's AI summary of the call: what was said and what to do next, as bullet points. */
export interface CallSummaryText {
    summary: string[];
    nextSteps: string[];
}

export interface CallTranscriptLine {
    /** The member who spoke (their Quo user id), or null for the other party. */
    speakerUserId: string | null;
    text: string;
    /** Seconds from the start of the call. */
    start: number;
    end: number;
}

/** A call as the record page, the timeline and the API read it. Never the transcript's full text in the summary. */
export interface CallView {
    id: string;
    provider: CallProvider;
    personId: string | null;
    /** The member on the call; null when Quo's user is not a member here. */
    memberId: string | null;
    direction: CallDirection;
    status: CallStatus;
    /** E.164, as Quo has them; a hand-logged call has the person's number dialled. */
    fromNumber: string | null;
    toNumber: string | null;
    /** ISO 8601. */
    startedAt: string;
    answeredAt: string | null;
    completedAt: string | null;
    durationSec: number | null;
    hasVoicemail: boolean;
    recordings: CallRecording[];
    summary: CallSummaryText | null;
    transcript: CallTranscriptLine[] | null;
    disposition: CallDisposition | null;
    /** The note written in the Call panel, on the person's timeline too. */
    noteId: string | null;
    /** The call in Quo's own app. */
    quoLink: string | null;
    createdAt: string;
    updatedAt: string;
}

/** What a `call.*` event carries, and a `linked-call.*` timeline entry shows: the call, without transcript or note body. */
export interface CallSummary {
    direction: CallDirection;
    status: CallStatus;
    durationSec: number | null;
    disposition: CallDisposition | null;
    fromNumber: string | null;
    toNumber: string | null;
    hasRecording: boolean;
    /** The AI summary's first lines, when Quo has made one. */
    summary: string[] | null;
    quoLink: string | null;
}

/**
 * Settings → Quo (CALL-1), an admin's: the API key (sealed, never shown back), whether the webhook is registered
 * at Quo, and which members Quo's users were matched to by email — a member unmatched has their calls logged as
 * nobody's until they join Quo under the same address.
 */
export interface QuoSettingsView {
    configured: boolean;
    /** The receiver Quo posts to; registered by the CRM itself when the key is saved. */
    webhookUrl: string;
    webhookRegistered: boolean;
    /** Members matched to a Quo user by email. */
    matchedMemberIds: string[];
    /** Quo users whose email is no member here. */
    unmatchedQuoEmails: string[];
    lastDeliveryAt: string | null;
    /** `recorded`, `updated`, `ignored`, `unknown_call` or `bad_signature`. */
    lastDeliveryResult: string | null;
}

/**
 * The calling code of each country the CRM dials to, for turning a person's `Phone` (digits as dialled, with a
 * country) into E.164 for the Quo app and for matching Quo's E.164 numbers back. Not every country: one the
 * table lacks is not dialled from the CRM, and its calls are matched by the number's last digits instead.
 */
export const CALLING_CODE_BY_COUNTRY: Readonly<Record<string, string>> = {
    US: '1',
    CA: '1',
    PR: '1',
    JM: '1',
    BS: '1',
    BB: '1',
    TT: '1',
    DO: '1',
    GB: '44',
    GG: '44',
    JE: '44',
    IM: '44',
    IE: '353',
    FR: '33',
    DE: '49',
    ES: '34',
    IT: '39',
    PT: '351',
    NL: '31',
    BE: '32',
    LU: '352',
    CH: '41',
    AT: '43',
    DK: '45',
    SE: '46',
    NO: '47',
    FI: '358',
    IS: '354',
    PL: '48',
    CZ: '420',
    SK: '421',
    HU: '36',
    RO: '40',
    BG: '359',
    GR: '30',
    TR: '90',
    UA: '380',
    RU: '7',
    KZ: '7',
    HR: '385',
    SI: '386',
    RS: '381',
    LT: '370',
    LV: '371',
    EE: '372',
    MT: '356',
    CY: '357',
    IL: '972',
    AE: '971',
    SA: '966',
    QA: '974',
    KW: '965',
    BH: '973',
    OM: '968',
    JO: '962',
    EG: '20',
    ZA: '27',
    NG: '234',
    KE: '254',
    GH: '233',
    MA: '212',
    TN: '216',
    IN: '91',
    PK: '92',
    BD: '880',
    LK: '94',
    NP: '977',
    CN: '86',
    HK: '852',
    TW: '886',
    JP: '81',
    KR: '82',
    SG: '65',
    MY: '60',
    TH: '66',
    VN: '84',
    PH: '63',
    ID: '62',
    AU: '61',
    NZ: '64',
    MX: '52',
    BR: '55',
    AR: '54',
    CL: '56',
    CO: '57',
    PE: '51',
};

/** A person's phone in E.164 (`+14155550123`); null when its country's code is not known here. */
export function e164Of(phone: { number: string; countryCode: string } | null | undefined): string | null {
    if (!phone) return null;
    const code = CALLING_CODE_BY_COUNTRY[phone.countryCode.toUpperCase()];
    if (!code) return null;
    const digits = phone.number.replace(/\D/g, '');
    if (digits === '') return null;
    // A number written with its trunk prefix (`020 …`, `0151 …`) loses it in E.164; North America has none.
    const national = code === '1' ? digits : digits.replace(/^0/, '');
    return `+${code}${national}`;
}

/** The digits two numbers are compared by: the last nine, which no calling code or trunk prefix changes. */
export function phoneTail(numberOrE164: string): string {
    return numberOrE164.replace(/\D/g, '').slice(-9);
}
