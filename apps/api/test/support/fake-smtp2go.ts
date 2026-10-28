import { assertNoOpenTransaction } from '../../src/infra/transaction-scope';
import { Smtp2GoError, type Smtp2GoPort, type Smtp2GoSent } from '../../src/smtp2go/smtp2go.port';

/** SMTP2Go in memory (TRANS-1): what was sent with which key, and failures a test queues. */
export class FakeSmtp2Go implements Smtp2GoPort {
    readonly sent: { apiKey: string; mime: string; emailId: string }[] = [];
    private failures: Smtp2GoError[] = [];
    private next = 1;
    /** SMTP2Go's suppressions as a test sets them; null — the default — is a key that may not read them. */
    private suppressions: Map<string, string> | null = null;

    /** SMTP2Go's suppressions hold these addresses, for these reasons (`unsubscribe`, `spam`, `bounce`, …). */
    holdSuppressions(entries: Record<string, string>): void {
        this.suppressions = new Map(Object.entries(entries).map(([a, r]) => [a.toLowerCase(), r]));
    }

    /** The next send fails this way (`retry`: 503; `refused`: 401; `unconfirmed`: 500). */
    failNext(outcome: Smtp2GoError['outcome']): void {
        const status = outcome === 'retry' ? 503 : outcome === 'refused' ? 401 : 500;
        this.failures.push(new Smtp2GoError(status, outcome, outcome === 'refused' ? 'api_key_invalid' : 'error'));
    }

    sendMime(apiKey: string, mime: string): Promise<Smtp2GoSent> {
        assertNoOpenTransaction('FakeSmtp2Go.sendMime');
        const failure = this.failures.shift();
        if (failure) return Promise.reject(failure);
        const emailId = `fake-${this.next++}`;
        this.sent.push({ apiKey, mime, emailId });
        return Promise.resolve({ emailId });
    }

    suppressionOf(_apiKey: string, address: string): Promise<string | null> {
        assertNoOpenTransaction('FakeSmtp2Go.suppressionOf');
        if (!this.suppressions) {
            return Promise.reject(new Smtp2GoError(403, 'refused', 'E_ApiResponseCodes.ENDPOINT_PERMISSION_DENIED'));
        }
        return Promise.resolve(this.suppressions.get(address.toLowerCase()) ?? null);
    }

    clear(): void {
        this.sent.length = 0;
        this.failures = [];
        this.suppressions = null;
    }
}
