import { Injectable } from '@nestjs/common';
import { CALENDAR_API_BASE, CALENDAR_HTTP_TIMEOUT_MS, CALENDAR_PAGE_SIZE } from './calendar.constants';
import {
    GoogleCalendarError,
    type GoogleCalendarPort,
    type GoogleEventPage,
    type GoogleRawEvent,
} from './google-calendar.port';

/**
 * Google Calendar's REST API (CAL-1): the only code in the product that reads a calendar. The bearer
 * token comes from `MailboxTokens`; nothing here stores it, and no error message carries it.
 */
@Injectable()
export class GoogleCalendarHttp implements GoogleCalendarPort {
    async listEvents(
        accessToken: string,
        input: { timeMin: Date; timeMax: Date; updatedMin?: Date; pageToken?: string },
    ): Promise<GoogleEventPage> {
        const params = new URLSearchParams({
            singleEvents: 'true',
            showDeleted: 'true',
            maxResults: String(CALENDAR_PAGE_SIZE),
            timeMin: input.timeMin.toISOString(),
            timeMax: input.timeMax.toISOString(),
        });
        if (input.updatedMin) params.set('updatedMin', input.updatedMin.toISOString());
        if (input.pageToken) params.set('pageToken', input.pageToken);
        const body = await this.get(accessToken, `/events?${params.toString()}`);
        const items = Array.isArray(body['items']) ? (body['items'] as Record<string, unknown>[]) : [];
        return {
            items: items.filter((item) => typeof item['id'] === 'string') as unknown as GoogleRawEvent[],
            nextPageToken: typeof body['nextPageToken'] === 'string' ? body['nextPageToken'] : null,
        };
    }

    private async get(accessToken: string, path: string): Promise<Record<string, unknown>> {
        let response: Response;
        try {
            response = await fetch(`${CALENDAR_API_BASE}${path}`, {
                headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
                signal: AbortSignal.timeout(CALENDAR_HTTP_TIMEOUT_MS),
            });
        } catch (error) {
            const timedOut = error instanceof Error && error.name === 'TimeoutError';
            const reason = timedOut ? 'timeout' : 'network';
            throw new GoogleCalendarError(null, reason, `Google Calendar did not answer (${reason})`);
        }
        let body: unknown;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        if (!response.ok) {
            const reason = errorReason(body) ?? `http_${response.status}`;
            throw new GoogleCalendarError(
                response.status,
                reason,
                `Google Calendar answered ${response.status} (${reason})`,
            );
        }
        if (typeof body !== 'object' || body === null) {
            throw new GoogleCalendarError(
                response.status,
                'unexpected_response',
                'Google Calendar answered with no JSON object',
            );
        }
        return body as Record<string, unknown>;
    }
}

/** Google's error reason (`{ error: { errors: [{ reason }], status } }`), when it gave one. */
export function errorReason(body: unknown): string | null {
    const error = (body as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null)?.error;
    const reason = error?.errors?.[0]?.reason ?? error?.status;
    return typeof reason === 'string' ? reason : null;
}
