import { assertNoOpenTransaction } from '../infra/transaction-scope';
import { RESEND_SEND_URL, RESEND_TIMEOUT_MS } from './transactional-mail.constants';
import { PermanentMailError, type OutgoingMail, type TransactionalMailTransport } from './transport.port';

/** Status codes for which Resend's refusal cannot change on a retry. */
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 405, 422]);

/** A failure worth retrying: the queue's backoff will try again. Carries no payload. */
export class TransientMailError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TransientMailError';
    }
}

/**
 * Transactional mail through Resend's HTTP API (#93, D-246). One request per message, with the
 * mail's idempotency key as `Idempotency-Key`: Resend answers a repeat within 24 hours with the
 * first result instead of sending again, which is what makes a retry after a lost answer safe.
 *
 * Errors are split for the queue: a refusal a retry cannot fix (bad key, unverified domain, invalid
 * address, a key reused for a different payload) is `PermanentMailError`; a network failure, a
 * timeout, `429` and `5xx` are retried. Neither carries the message body or the key into a log.
 */
export class ResendTransport implements TransactionalMailTransport {
    constructor(
        private readonly apiKey: string,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    async send(mail: OutgoingMail): Promise<{ id: string }> {
        assertNoOpenTransaction('Resend send');
        let res: Response;
        try {
            res = await this.fetchImpl(RESEND_SEND_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': mail.idempotencyKey,
                },
                body: JSON.stringify({
                    from: mail.from,
                    to: [mail.to],
                    subject: mail.subject,
                    html: mail.html,
                    text: mail.text,
                }),
                signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
            });
        } catch (error) {
            const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'network error';
            throw new TransientMailError(`Resend request failed: ${reason}`);
        }
        const body = (await res.json().catch(() => ({}))) as { id?: unknown; name?: unknown; message?: unknown };
        if (res.ok && typeof body.id === 'string') return { id: body.id };
        const name = typeof body.name === 'string' ? body.name : `http_${res.status}`;
        // Same key, different payload: a retry can never succeed. Two requests racing on one key: it can.
        if (res.status === 409) {
            if (name === 'concurrent_idempotent_requests') throw new TransientMailError(`Resend ${name}`);
            throw new PermanentMailError('resend', name);
        }
        if (PERMANENT_STATUS.has(res.status)) throw new PermanentMailError('resend', name);
        throw new TransientMailError(`Resend answered ${res.status} (${name})`);
    }
}
