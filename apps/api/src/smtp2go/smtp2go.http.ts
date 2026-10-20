import { SMTP2GO_API_URL, SMTP2GO_HTTP_TIMEOUT_MS } from './smtp2go.constants';
import { Smtp2GoError, type Smtp2GoPort, type Smtp2GoSent } from './smtp2go.port';

/** What fetch the adapter uses; tests pass their own. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * SMTP2Go's v3 API (TRANS-1): `POST /email/mime` with the key in `X-Smtp2go-Api-Key` and the message base64 in
 * `mime_email`. A `200` with `data.succeeded >= 1` and an `email_id` is a send; anything else is a `Smtp2GoError`
 * whose `outcome` decides whether the queue retries. Only SMTP2Go's error code is kept — never the key or the body.
 * Bound with a factory (the fetch is a test seam, not a provider).
 */
export class Smtp2GoHttp implements Smtp2GoPort {
    constructor(private readonly fetchFn: FetchLike = (url, init) => fetch(url, init)) {}

    async sendMime(apiKey: string, mime: string): Promise<Smtp2GoSent> {
        let res: Response;
        try {
            res = await this.fetchFn(`${SMTP2GO_API_URL}/email/mime`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-Smtp2go-Api-Key': apiKey,
                },
                body: JSON.stringify({ mime_email: Buffer.from(mime, 'utf8').toString('base64') }),
                signal: AbortSignal.timeout(SMTP2GO_HTTP_TIMEOUT_MS),
            });
        } catch (error) {
            // A refused connection never reached SMTP2Go; a timeout may have.
            const reached = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
            throw new Smtp2GoError(0, reached ? 'unconfirmed' : 'retry', reached ? 'timeout' : 'unreachable');
        }
        const body = (await res.json().catch(() => null)) as {
            data?: { succeeded?: number; email_id?: string; error_code?: string; failures?: unknown[] };
        } | null;
        if (res.ok && body?.data?.email_id && (body.data.succeeded ?? 0) >= 1) {
            return { emailId: body.data.email_id };
        }
        const reason = typeof body?.data?.error_code === 'string' ? body.data.error_code.slice(0, 80) : 'error';
        if (res.ok) throw new Smtp2GoError(res.status, 'refused', reason);
        if (res.status === 429 || res.status === 503) throw new Smtp2GoError(res.status, 'retry', reason);
        if (res.status >= 500) throw new Smtp2GoError(res.status, 'unconfirmed', reason);
        throw new Smtp2GoError(res.status, 'refused', reason);
    }
}
