import { Injectable } from '@nestjs/common';
import {
    GmailApiError,
    type GmailHistoryPage,
    type GmailMessagePage,
    type GmailPort,
    type GmailProfile,
    type GmailRawMessage,
} from './gmail.port';
import { GMAIL_API_BASE, GMAIL_HTTP_TIMEOUT_MS, GMAIL_LIST_PAGE_SIZE } from './mail-sync.constants';

/**
 * Gmail's REST API (P2-2): the only code in the product that reads mail from Google. The bearer
 * token comes from `MailboxTokens`; nothing here stores it, and no error message carries it.
 */
@Injectable()
export class GmailHttp implements GmailPort {
    async getProfile(accessToken: string): Promise<GmailProfile> {
        const body = await this.get(accessToken, '/profile');
        return { emailAddress: str(body['emailAddress']), historyId: str(body['historyId']) };
    }

    async listMessages(accessToken: string, input: { query: string; pageToken?: string }): Promise<GmailMessagePage> {
        const params = new URLSearchParams({ q: input.query, maxResults: String(GMAIL_LIST_PAGE_SIZE) });
        if (input.pageToken) params.set('pageToken', input.pageToken);
        const body = await this.get(accessToken, `/messages?${params.toString()}`);
        const messages = Array.isArray(body['messages']) ? (body['messages'] as Record<string, unknown>[]) : [];
        return {
            messages: messages.map((m) => ({ id: str(m['id']), threadId: str(m['threadId']) })),
            nextPageToken: typeof body['nextPageToken'] === 'string' ? body['nextPageToken'] : null,
        };
    }

    async listHistory(
        accessToken: string,
        input: { startHistoryId: string; pageToken?: string },
    ): Promise<GmailHistoryPage> {
        const params = new URLSearchParams({ startHistoryId: input.startHistoryId, historyTypes: 'messageAdded' });
        if (input.pageToken) params.set('pageToken', input.pageToken);
        const body = await this.get(accessToken, `/history?${params.toString()}`);
        const history = Array.isArray(body['history']) ? (body['history'] as Record<string, unknown>[]) : [];
        const added = history.flatMap((h) =>
            Array.isArray(h['messagesAdded'])
                ? (h['messagesAdded'] as { message?: { id?: unknown } }[]).map((a) => str(a.message?.id))
                : [],
        );
        return {
            addedMessageIds: added,
            historyId: str(body['historyId']),
            nextPageToken: typeof body['nextPageToken'] === 'string' ? body['nextPageToken'] : null,
        };
    }

    async getMessage(accessToken: string, id: string): Promise<GmailRawMessage> {
        const body = await this.get(accessToken, `/messages/${encodeURIComponent(id)}?format=full`);
        if (typeof body['id'] !== 'string' || typeof body['payload'] !== 'object' || body['payload'] === null) {
            throw new GmailApiError(null, 'unexpected_response', 'Gmail returned a message without an id or payload');
        }
        return body as unknown as GmailRawMessage;
    }

    private async get(accessToken: string, path: string): Promise<Record<string, unknown>> {
        let response: Response;
        try {
            response = await fetch(`${GMAIL_API_BASE}${path}`, {
                headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
                signal: AbortSignal.timeout(GMAIL_HTTP_TIMEOUT_MS),
            });
        } catch (error) {
            const timedOut = error instanceof Error && error.name === 'TimeoutError';
            throw new GmailApiError(
                null,
                timedOut ? 'timeout' : 'network',
                `Gmail did not answer (${timedOut ? 'timeout' : 'network'})`,
            );
        }
        let body: unknown;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        if (!response.ok) {
            const reason = errorReason(body) ?? `http_${response.status}`;
            throw new GmailApiError(response.status, reason, `Gmail answered ${response.status} (${reason})`);
        }
        if (typeof body !== 'object' || body === null) {
            throw new GmailApiError(response.status, 'unexpected_response', 'Gmail answered with no JSON object');
        }
        return body as Record<string, unknown>;
    }
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
}

/** Gmail's error reason (`{ error: { errors: [{ reason }] , status } }`), when it gave one. */
function errorReason(body: unknown): string | null {
    const error = (body as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null)?.error;
    const reason = error?.errors?.[0]?.reason ?? error?.status;
    return typeof reason === 'string' ? reason : null;
}
