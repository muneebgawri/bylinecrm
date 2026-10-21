import { Injectable } from '@nestjs/common';
import { NEWSWIREOS_OWNERSHIP_PATH, NEWSWIREOS_TIMEOUT_MS } from './invoices.constants';
import { NewswireosApiError, type NewswireosLink } from './newswireos-verification.port';
import type { NewswireosOwnershipPort, OwnershipChangedBody, OwnershipPushAnswer } from './ownership-push.port';

/**
 * The ownership push over HTTP (PNW-765). The token goes as a bearer token and nowhere else: never into a message
 * or a log.
 */
@Injectable()
export class NewswireosOwnershipHttp implements NewswireosOwnershipPort {
    async push(link: NewswireosLink, body: OwnershipChangedBody): Promise<OwnershipPushAnswer> {
        let response: Response;
        try {
            response = await fetch(`${link.baseUrl.replace(/\/+$/, '')}${NEWSWIREOS_OWNERSHIP_PATH}`, {
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
        const o = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
        const reasonCode = text(o['reason_code'], 100);
        if (!response.ok) {
            throw new NewswireosApiError(
                response.status,
                text(o['message'], 300) ?? `NewswireOS answered ${response.status}`,
                reasonCode,
            );
        }
        return parseOwnershipAnswer(answer);
    }
}

/** NewswireOS's answer, read defensively. Exported for its spec. */
export function parseOwnershipAnswer(body: unknown): OwnershipPushAnswer {
    const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    return {
        matched: o['matched'] === true,
        customers: (Array.isArray(o['customers']) ? (o['customers'] as unknown[]) : [])
            .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>) : {}))
            .map((c) => ({
                customerId:
                    typeof c['customer_id'] === 'number' ? String(c['customer_id']) : text(c['customer_id'], 200),
                reasonCode: text(c['reason_code'], 100),
            }))
            .filter((c): c is { customerId: string; reasonCode: string | null } => c.customerId !== null)
            .slice(0, 100),
        reasonCode: text(o['reason_code'], 100),
    };
}

function text(value: unknown, max: number): string | null {
    return typeof value === 'string' && value !== '' ? value.slice(0, max) : null;
}
