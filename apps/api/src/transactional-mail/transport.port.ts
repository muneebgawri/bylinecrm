/** What a transactional mail is about (#93); the job name, the log line and the test filter. */
export type MailKind =
    | 'email_verification'
    | 'password_reset'
    | 'workspace_invitation'
    | 'signup_invitation'
    | 'twenty_sync_failing'
    | 'bigin_sync_failing'
    | 'task_digest'
    | 'guardrail_alert'
    | 'gmail_usage_high';

/** One message, rendered and addressed, as a transport sends it. */
export interface OutgoingMail {
    kind: MailKind;
    /** One recipient, lower-cased. Transactional mail never has more than one. */
    to: string;
    from: string;
    subject: string;
    html: string;
    text: string;
    /**
     * The mail's identity: the queue's job id, and the provider's idempotency key, so a retry after
     * a lost answer is not a second message.
     */
    idempotencyKey: string;
}

/** Sends one message. Throws `PermanentMailError` for a refusal a retry cannot fix; anything else is retried. */
export interface TransactionalMailTransport {
    send(mail: OutgoingMail): Promise<{ id: string }>;
}

/** Injection token for the transport this process sends with. */
export const TRANSACTIONAL_MAIL_TRANSPORT = Symbol('TRANSACTIONAL_MAIL_TRANSPORT');

/**
 * The provider refused the message for a reason a retry cannot change: a bad or revoked key, an
 * unverified sending domain, an invalid address. The job fails at once instead of retrying.
 */
export class PermanentMailError extends Error {
    constructor(
        readonly provider: string,
        readonly reason: string,
    ) {
        super(`${provider} refused the message: ${reason}`);
        this.name = 'PermanentMailError';
    }
}
