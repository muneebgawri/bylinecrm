import { Injectable } from '@nestjs/common';
import { NEWSWIREOS_LOOKUP_PATH, NEWSWIREOS_TIMEOUT_MS } from './invoices.constants';
import {
    NewswireosApiError,
    type NewswireosDecision,
    type NewswireosLink,
    type NewswireosLookupRequest,
    type NewswireosLookupResult,
    type NewswireosVerificationPort,
} from './newswireos-verification.port';

const DECISIONS: readonly NewswireosDecision[] = ['verified', 'invalid', 'needs_review', 'pending'];

/**
 * NewswireOS's lookup over HTTP (INV-1). The token goes as a bearer token and nowhere else: never into a message
 * or a log. An answer without a decision NewswireOS could make is `needs_review`: uncertainty never passes.
 */
@Injectable()
export class NewswireosVerificationHttp implements NewswireosVerificationPort {
    async lookup(link: NewswireosLink, request: NewswireosLookupRequest): Promise<NewswireosLookupResult> {
        let response: Response;
        try {
            response = await fetch(`${link.baseUrl.replace(/\/+$/, '')}${NEWSWIREOS_LOOKUP_PATH}`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${link.apiToken}`,
                    accept: 'application/json',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    reference: request.reference,
                    gateway: request.gateway,
                    amount_cents: request.amountCents,
                    currency: request.currency,
                }),
                signal: AbortSignal.timeout(NEWSWIREOS_TIMEOUT_MS),
            });
        } catch (error) {
            const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network';
            throw new NewswireosApiError(null, `NewswireOS did not answer (${reason})`);
        }
        let body: unknown;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        if (!response.ok) {
            const message = (body as { message?: unknown } | null)?.message;
            throw new NewswireosApiError(
                response.status,
                typeof message === 'string' ? message.slice(0, 300) : `NewswireOS answered ${response.status}`,
            );
        }
        return parseLookup(body);
    }
}

/** NewswireOS's answer, read defensively. Exported for its spec. */
export function parseLookup(body: unknown): NewswireosLookupResult {
    const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const status = DECISIONS.find((d) => d === o['status']);
    const { status: _status, reason_code: reason, canonical_reference: canonical, ...facts } = o;
    const canonicalReference = typeof canonical === 'string' && canonical !== '' ? canonical.slice(0, 500) : null;
    if (!status) return { status: 'needs_review', reasonCode: 'NO_DECISION', canonicalReference, facts };
    // Another release already holds the payment. It may well be this deal's own (the release it paid for), so a
    // person decides rather than the CRM refusing it: uncertainty never passes, and never refuses on a guess.
    if (o['already_used'] === true && status !== 'invalid') {
        return { status: 'needs_review', reasonCode: 'ALREADY_USED', canonicalReference, facts };
    }
    return {
        status,
        reasonCode: typeof reason === 'string' && reason !== '' ? reason.slice(0, 100) : null,
        canonicalReference,
        facts,
    };
}
