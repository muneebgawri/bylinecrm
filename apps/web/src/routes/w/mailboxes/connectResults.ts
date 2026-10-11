import {
    GMAIL_BROAD_SCOPE,
    MAILBOX_CONNECT_RESULTS,
    MAILBOX_CONNECT_RESULT_PARAM,
    type MailboxConnectResult,
} from '@bylinecrm/shared';
import type { Tone } from '@bylinecrm/ui';

export { MAILBOX_CONNECT_RESULT_PARAM };

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

/** The result in a query-string value, when it is one the API reports; anything else is ignored. */
export function connectResultFrom(value: string | null): MailboxConnectResult | null {
    return (MAILBOX_CONNECT_RESULTS as readonly string[]).includes(value ?? '')
        ? (value as MailboxConnectResult)
        : null;
}
