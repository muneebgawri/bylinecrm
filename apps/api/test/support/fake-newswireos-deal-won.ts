import type { DealWonAnswer, DealWonBody, NewswireosDealWonPort } from '../../src/invoices/deal-won-push.port';
import { NewswireosApiError, type NewswireosLink } from '../../src/invoices/newswireos-verification.port';

/**
 * NewswireOS's `deal-won` route for the suite (PNW-766): answers whatever the test queued next (a new client by
 * default), and remembers every call so a test can see what the CRM sent, and with which token.
 */
export class FakeNewswireosDealWon implements NewswireosDealWonPort {
    readonly calls: { link: NewswireosLink; body: DealWonBody }[] = [];
    private readonly queued: (DealWonAnswer | NewswireosApiError)[] = [];

    /** The next answers, in order; once they run out, every push makes client `cus_1`. */
    next(...answers: (DealWonAnswer | NewswireosApiError)[]): void {
        this.queued.push(...answers);
    }

    reset(): void {
        this.calls.length = 0;
        this.queued.length = 0;
    }

    push(link: NewswireosLink, body: DealWonBody): Promise<DealWonAnswer> {
        this.calls.push({ link, body });
        const answer = this.queued.shift() ?? {
            customerId: 'cus_1',
            parentCustomerId: null,
            reasonCode: 'CREATED',
            amReasonCode: 'REASSIGNED',
        };
        return answer instanceof NewswireosApiError ? Promise.reject(answer) : Promise.resolve(answer);
    }
}
