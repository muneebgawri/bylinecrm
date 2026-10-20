import { assertNoOpenTransaction } from '../../src/infra/transaction-scope';
import { Smtp2GoError, type Smtp2GoPort, type Smtp2GoSent } from '../../src/smtp2go/smtp2go.port';

/** SMTP2Go in memory (TRANS-1): what was sent with which key, and failures a test queues. */
export class FakeSmtp2Go implements Smtp2GoPort {
    readonly sent: { apiKey: string; mime: string; emailId: string }[] = [];
    private failures: Smtp2GoError[] = [];
    private next = 1;

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

    clear(): void {
        this.sent.length = 0;
        this.failures = [];
    }
}
