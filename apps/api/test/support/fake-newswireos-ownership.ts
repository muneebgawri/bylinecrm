import { NewswireosApiError, type NewswireosLink } from '../../src/invoices/newswireos-verification.port';
import type {
    NewswireosOwnershipPort,
    OwnershipChangedBody,
    OwnershipPushAnswer,
} from '../../src/invoices/ownership-push.port';

/**
 * NewswireOS's `ownership-changed` route for the suite (PNW-765): answers whatever the test queued next (a match
 * by default), and remembers every call so a test can see what the CRM sent, and with which token.
 */
export class FakeNewswireosOwnership implements NewswireosOwnershipPort {
    readonly calls: { link: NewswireosLink; body: OwnershipChangedBody }[] = [];
    private readonly queued: (OwnershipPushAnswer | NewswireosApiError)[] = [];

    /** The next answers, in order; once they run out, every push is matched. */
    next(...answers: (OwnershipPushAnswer | NewswireosApiError)[]): void {
        this.queued.push(...answers);
    }

    reset(): void {
        this.calls.length = 0;
        this.queued.length = 0;
    }

    push(link: NewswireosLink, body: OwnershipChangedBody): Promise<OwnershipPushAnswer> {
        this.calls.push({ link, body });
        const answer = this.queued.shift() ?? {
            matched: true,
            reasonCode: 'REASSIGNED',
            customers: [{ customerId: 'cus_1', reasonCode: 'REASSIGNED' }],
        };
        return answer instanceof NewswireosApiError ? Promise.reject(answer) : Promise.resolve(answer);
    }
}
