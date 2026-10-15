import {
    GMAIL_BROAD_SCOPE,
    MAILBOX_CONNECT_PURPOSE_PARAM,
    MAILBOX_CONNECT_RESULTS,
    MAILBOX_CONNECT_RESULT_PARAM,
    type MailboxConnectResult,
} from '@bylinecrm/shared';
import type { Tone } from '@bylinecrm/ui';

export { MAILBOX_CONNECT_PURPOSE_PARAM, MAILBOX_CONNECT_RESULT_PARAM };

export interface ConnectResultMessage {
    title: string;
    /** What happened, and what the person can do about it. */
    body: string;
    tone: Extract<Tone, 'success' | 'danger'>;
}

/**
 * What the person reads when Google sends them back (P2-1's callback puts one of these in
 * `?connect=`). One entry per result the API can report — the `Record` makes a new result a type
 * error here until it has words.
 */
export const CONNECT_RESULT_MESSAGES: Record<MailboxConnectResult, ConnectResultMessage> = {
    connected: {
        title: 'Mailbox connected',
        body: 'Its last 30 days of mail are being imported now; new mail follows every few minutes.',
        tone: 'success',
    },
    denied: {
        title: 'Google access was declined',
        body: 'Nothing was connected. Connect again and choose Allow on Google’s screen.',
        tone: 'danger',
    },
    invalid_state: {
        title: 'That connect link expired',
        body: 'Connect links last ten minutes and work once. Start again from Connect mailbox.',
        tone: 'danger',
    },
    wrong_user: {
        title: 'Signed in as someone else',
        body: 'The person who started the connect has to finish it, signed in to this app in the same browser. Start again from your own account.',
        tone: 'danger',
    },
    not_permitted: {
        title: 'You can no longer connect mailboxes here',
        body: 'Your role changed while you were at Google. Ask an admin for permission to manage mailboxes.',
        tone: 'danger',
    },
    no_client: {
        title: 'Google is no longer set up',
        body: 'The workspace’s OAuth client was removed or replaced while you were at Google. Ask an admin to set it up, then connect again.',
        tone: 'danger',
    },
    scope_too_broad: {
        title: 'Full mailbox access was granted',
        body: `The app only accepts send and read access, so nothing was kept. Remove ${GMAIL_BROAD_SCOPE} from the OAuth consent screen in Google Cloud, then connect again.`,
        tone: 'danger',
    },
    scope_missing: {
        title: 'Send or read access was not granted',
        body: 'Both are needed. Connect again and leave both boxes ticked on Google’s screen; if they aren’t offered, an admin adds gmail.send and gmail.readonly to the consent screen.',
        tone: 'danger',
    },
    no_refresh_token: {
        title: 'Google did not allow a lasting connection',
        body: 'Remove this app’s access in the Google account’s security settings, then connect again so Google asks for consent afresh.',
        tone: 'danger',
    },
    owned_by_another: {
        title: 'Another member connected this mailbox',
        body: 'A mailbox belongs to one member. Ask them, or an admin, to disconnect it first.',
        tone: 'danger',
    },
    purpose_mismatch: {
        title: 'This mailbox is connected for the other purpose',
        body: 'A mailbox is either personal or shared outreach. Disconnect it, then connect it again with the purpose you want.',
        tone: 'danger',
    },
    exchange_failed: {
        title: 'Google refused the connection',
        body: 'The OAuth client’s secret or redirect URI may be wrong. An admin can check them in Google setup, then try again.',
        tone: 'danger',
    },
};

/**
 * The same callback finishes a Postmaster Tools connect (#129, `?for=postmaster`): the results that
 * read differently for it — the rest (declined, expired, wrong person…) say the same for both.
 */
/**
 * A personal mailbox's connect asks for its Google Calendar too (CAL-1): connected, its meetings with
 * people outside the workspace are read as well — when the person left the calendar box ticked.
 */
const PERSONAL_RESULT_MESSAGES: Partial<Record<MailboxConnectResult, ConnectResultMessage>> = {
    connected: {
        title: 'Mailbox connected',
        body: 'Its last 30 days of mail are being imported now; new mail follows every few minutes. If you allowed the calendar, your meetings with people outside the workspace count towards your KPIs and their attendees become your leads.',
        tone: 'success',
    },
};

const POSTMASTER_RESULT_MESSAGES: Partial<Record<MailboxConnectResult, ConnectResultMessage>> = {
    connected: {
        title: 'Postmaster Tools connected',
        body: 'Each sending-domain check now reads the domain’s user-reported spam rate for the day before.',
        tone: 'success',
    },
    scope_missing: {
        title: 'Postmaster Tools access was not granted',
        body: 'Connect again and leave the Postmaster Tools box ticked on Google’s screen; if it isn’t offered, an admin adds postmaster.readonly to the consent screen and enables the Postmaster Tools API.',
        tone: 'danger',
    },
    not_permitted: {
        title: 'You can no longer connect Postmaster Tools here',
        body: 'Your role changed while you were at Google. The Postmaster Tools account is connected by an admin.',
        tone: 'danger',
    },
};

/** What the person reads for a result, given what the connect was for (`?for=`). */
export function connectMessage(result: MailboxConnectResult, purpose: string | null): ConnectResultMessage {
    return (
        (purpose === 'postmaster' && POSTMASTER_RESULT_MESSAGES[result]) ||
        (purpose === 'personal' && PERSONAL_RESULT_MESSAGES[result]) ||
        CONNECT_RESULT_MESSAGES[result]
    );
}

/** The result in a query-string value, when it is one the API reports; anything else is ignored. */
export function connectResultFrom(value: string | null): MailboxConnectResult | null {
    return (MAILBOX_CONNECT_RESULTS as readonly string[]).includes(value ?? '')
        ? (value as MailboxConnectResult)
        : null;
}
