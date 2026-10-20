/**
 * SMTP2Go (TRANS-1), behind one interface: sending one stored message as it is. The HTTP adapter
 * (`smtp2go.http.ts`, SMTP2Go's v3 API) is the only code that talks to it; tests bind an in-memory fake
 * (`test/support/fake-smtp2go.ts`), so no test and no CI run ever calls SMTP2Go. Never called inside a
 * database transaction. Only a pool mailbox's outreach goes this way — never 1:1 or personal mail.
 */
export const SMTP2GO_PORT = Symbol('SMTP2GO_PORT');

/** What SMTP2Go said it took: its id for the message, which its webhook names it by. */
export interface Smtp2GoSent {
    emailId: string;
}

export interface Smtp2GoPort {
    /**
     * Sends the RFC 5322 message exactly as built (`/email/mime`), so our Message-ID, `X-BylineCRM-Id`,
     * `List-Unsubscribe` and tracked links go as they are. The API key is the mailbox's, opened for this call
     * only, and never logged.
     */
    sendMime(apiKey: string, mime: string): Promise<Smtp2GoSent>;
}

/**
 * SMTP2Go refused or could not be reached. `outcome` says what the CRM may do next:
 * - `retry`: the message certainly did not go (no connection, `429`, `503`) — the queue tries again;
 * - `refused`: it will not go as it is (`4xx`: a bad key, an unverified sender, a rejected recipient);
 * - `unconfirmed`: it may have gone (a timeout after the request left, another `5xx`) — never sent again
 *   automatically, since SMTP2Go has no idempotency key; the send is failed and says so.
 */
export class Smtp2GoError extends Error {
    constructor(
        readonly status: number,
        readonly outcome: 'retry' | 'refused' | 'unconfirmed',
        readonly reason: string,
    ) {
        super(`SMTP2Go answered ${status || 'nothing'} (${reason})`);
    }
}
