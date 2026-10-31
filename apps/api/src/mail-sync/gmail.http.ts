import { Injectable } from '@nestjs/common';
import { retryAfterOfGoogleMessage, retryAfterSecondsOf } from '../infra/retry-after';
import {
    GmailApiError,
    type GmailHistoryPage,
    type GmailMessagePage,
    type GmailPort,
    type GmailProfile,
    type GmailRawMessage,
    type GmailMessageHeaders,
    type GmailSendAs,
    type GmailSent,
} from './gmail.port';
import { GMAIL_API_BASE, GMAIL_HTTP_TIMEOUT_MS, GMAIL_LIST_PAGE_SIZE } from './mail-sync.constants';

/**
 * Gmail's REST API (P2-2, P2-3): the only code in the product that reads or sends mail through Google. The bearer
 * token comes from `MailboxTokens`; nothing here stores it, and no error message carries it.
 */
@Injectable()
export class GmailHttp implements GmailPort {
    async listSendAs(accessToken: string): Promise<GmailSendAs[]> {
        const body = await this.get(accessToken, '/settings/sendAs');
        const list = Array.isArray(body['sendAs']) ? (body['sendAs'] as Record<string, unknown>[]) : [];
        return list.map((s) => ({
            sendAsEmail: str(s['sendAsEmail']),
            isPrimary: s['isPrimary'] === true,
            signature: typeof s['signature'] === 'string' ? s['signature'] : '',
        }));
    }

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
        params.append('historyTypes', 'messageDeleted');
        if (input.pageToken) params.set('pageToken', input.pageToken);
        const body = await this.get(accessToken, `/history?${params.toString()}`);
        const history = Array.isArray(body['history']) ? (body['history'] as Record<string, unknown>[]) : [];
        const ids = (key: 'messagesAdded' | 'messagesDeleted') =>
            history.flatMap((h) =>
                Array.isArray(h[key])
                    ? (h[key] as { message?: { id?: unknown } }[]).map((a) => str(a.message?.id))
                    : [],
            );
        return {
            addedMessageIds: ids('messagesAdded'),
            deletedMessageIds: ids('messagesDeleted'),
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

    async getMessageHeaders(accessToken: string, id: string, names: readonly string[]): Promise<GmailMessageHeaders> {
        const params = new URLSearchParams({ format: 'metadata' });
        for (const name of names) params.append('metadataHeaders', name);
        const body = await this.get(accessToken, `/messages/${encodeURIComponent(id)}?${params.toString()}`);
        if (typeof body['id'] !== 'string' || typeof body['threadId'] !== 'string') {
            throw new GmailApiError(null, 'unexpected_response', 'Gmail returned a message without an id or thread');
        }
        const payload = (body['payload'] ?? {}) as { headers?: unknown };
        const headers = Array.isArray(payload.headers)
            ? (payload.headers as { name?: unknown; value?: unknown }[])
                  .filter((h) => typeof h.name === 'string' && typeof h.value === 'string')
                  .map((h) => ({ name: h.name as string, value: h.value as string }))
            : [];
        return { id: body['id'], threadId: body['threadId'], headers };
    }

    async send(accessToken: string, input: { raw: string; threadId?: string }): Promise<GmailSent> {
        const payload = {
            raw: Buffer.from(input.raw, 'utf8').toString('base64url'),
            ...(input.threadId ? { threadId: input.threadId } : {}),
        };
        const body = await this.request(accessToken, '/messages/send', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
        if (typeof body['id'] !== 'string' || typeof body['threadId'] !== 'string') {
            throw new GmailApiError(
                null,
                'unexpected_response',
                'Gmail returned a sent message without an id or thread',
            );
        }
        return { id: body['id'], threadId: body['threadId'] };
    }

    private get(accessToken: string, path: string): Promise<Record<string, unknown>> {
        return this.request(accessToken, path, { method: 'GET' });
    }

    private async request(
        accessToken: string,
        path: string,
        init: { method: 'GET' | 'POST'; body?: string },
    ): Promise<Record<string, unknown>> {
        let response: Response;
        try {
            response = await fetch(`${GMAIL_API_BASE}${path}`, {
                method: init.method,
                headers: {
                    authorization: `Bearer ${accessToken}`,
                    accept: 'application/json',
                    ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
                },
                ...(init.body !== undefined ? { body: init.body } : {}),
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
            const googleMessage = errorMessage(body);
            const headerSeconds = retryAfterSecondsOf(response.headers.get('retry-after'), new Date());
            const retryAfter =
                headerSeconds !== null
                    ? new Date(Date.now() + headerSeconds * 1000)
                    : retryAfterOfGoogleMessage(googleMessage);
            throw new GmailApiError(
                response.status,
                reason,
                `Gmail answered ${response.status} (${reason})`,
                googleMessage,
                retryAfter,
            );
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

/** Gmail's error message (`{ error: { message } }`, else the first `errors[].message`), when it gave one. */
function errorMessage(body: unknown): string | null {
    const error = (body as { error?: { message?: unknown; errors?: { message?: unknown }[] } } | null)?.error;
    const message = error?.message ?? error?.errors?.[0]?.message;
    return typeof message === 'string' && message.trim() ? message.trim() : null;
}

/** Gmail's error reason (`{ error: { errors: [{ reason }] , status } }`), when it gave one. */
function errorReason(body: unknown): string | null {
    const error = (body as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null)?.error;
    const reason = error?.errors?.[0]?.reason ?? error?.status;
    return typeof reason === 'string' ? reason : null;
}
