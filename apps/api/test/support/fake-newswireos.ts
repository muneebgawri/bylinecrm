import {
    NewswireosApiError,
    type NewswireosLink,
    type NewswireosLookupRequest,
    type NewswireosLookupResult,
    type NewswireosVerificationPort,
} from '../../src/invoices/newswireos-verification.port';
import { parseLookup } from '../../src/invoices/newswireos-verification.http';

type Answer = NewswireosLookupResult | NewswireosApiError;

/**
 * NewswireOS's verification lookup for the suite (INV-1): answers by reference, `needs_review` for one it was
 * not told about, and remembers every call so a test can see what the CRM asked (and with which token).
 */
export class FakeNewswireos implements NewswireosVerificationPort {
    readonly calls: { link: NewswireosLink; request: NewswireosLookupRequest }[] = [];
    private readonly answers = new Map<string, Answer>();

    answer(reference: string, answer: Answer): void {
        this.answers.set(reference, answer);
    }

    /**
     * Answers with a body in NewswireOS's wire format (`status`, `reason_code`, provider `amount_cents`/`currency`,
     * `already_used`, …), read exactly as the HTTP adapter reads it.
     */
    answerWire(reference: string, body: Record<string, unknown>): void {
        this.answers.set(reference, parseLookup(body));
    }

    static decided(
        status: NewswireosLookupResult['status'],
        reasonCode: string | null = null,
        canonicalReference: string | null = null,
    ): NewswireosLookupResult {
        return { status, reasonCode, canonicalReference, facts: { paid_at: '2026-10-20T10:00:00Z' } };
    }

    lookup(link: NewswireosLink, request: NewswireosLookupRequest): Promise<NewswireosLookupResult> {
        this.calls.push({ link, request });
        const answer = this.answers.get(request.reference);
        if (answer instanceof NewswireosApiError) return Promise.reject(answer);
        return Promise.resolve(answer ?? FakeNewswireos.decided('needs_review', 'NO_DECISION'));
    }
}
