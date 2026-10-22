import { Injectable } from '@nestjs/common';
import type { DealWonAnswer, DealWonBody, NewswireosDealWonPort } from './deal-won-push.port';
import { NEWSWIREOS_DEAL_WON_PATH, NEWSWIREOS_TIMEOUT_MS } from './invoices.constants';
import { NewswireosApiError, type NewswireosLink } from './newswireos-verification.port';

/**
 * The deal-won push over HTTP (PNW-766). The token goes as a bearer token and nowhere else: never into a message or a
 * log.
 */
@Injectable()
export class NewswireosDealWonHttp implements NewswireosDealWonPort {
    async push(link: NewswireosLink, body: DealWonBody): Promise<DealWonAnswer> {
        let response: Response;
        try {
            response = await fetch(`${link.baseUrl.replace(/\/+$/, '')}${NEWSWIREOS_DEAL_WON_PATH}`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${link.apiToken}`,
                    accept: 'application/json',
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(NEWSWIREOS_TIMEOUT_MS),
            });
        } catch (error) {
            const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network';
            throw new NewswireosApiError(null, `NewswireOS did not answer (${reason})`);
        }
        let answer: unknown;
        try {
            answer = await response.json();
        } catch {
            answer = null;
        }
        if (!response.ok) {
            const o = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
            throw new NewswireosApiError(
                response.status,
                text(o['message'], 300) ?? `NewswireOS answered ${response.status}`,
                text(o['reason_code'], 100),
            );
        }
        return parseDealWonAnswer(answer);
    }
}

/** NewswireOS's answer, read defensively. Exported for its spec. */
export function parseDealWonAnswer(body: unknown): DealWonAnswer {
    const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    return {
        customerId: id(o['customer_id']),
        parentCustomerId: id(o['parent_customer_id']),
        reasonCode: text(o['reason_code'], 100),
        amReasonCode: text(o['am_reason_code'], 100),
    };
}

function id(value: unknown): string | null {
    return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value, 200);
}

function text(value: unknown, max: number): string | null {
    return typeof value === 'string' && value !== '' ? value.slice(0, max) : null;
}
