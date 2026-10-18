import { Injectable } from '@nestjs/common';
import { SlotlineApiError, type SlotlineApiPort, type SlotlineEventType } from './slotline-api.port';
import { SLOTLINE_API_EVENT_TYPES_VERSION, SLOTLINE_API_TIMEOUT_MS } from './slotline.constants';

/**
 * Slotline's v2 API over HTTP (#196): the booking site forwards `/api/v2/*` to it. The member's key goes
 * as a bearer token and nowhere else — never into a message or a log.
 */
@Injectable()
export class SlotlineApiHttp implements SlotlineApiPort {
    async me(baseUrl: string, apiKey: string): Promise<{ username: string }> {
        const data = await this.get(baseUrl, apiKey, '/me');
        const username = (data as { username?: unknown } | null)?.username;
        if (typeof username !== 'string' || username === '') {
            throw new SlotlineApiError(200, 'Slotline answered with no username');
        }
        return { username };
    }

    async eventTypes(baseUrl: string, apiKey: string): Promise<SlotlineEventType[]> {
        const data = await this.get(baseUrl, apiKey, '/event-types', SLOTLINE_API_EVENT_TYPES_VERSION);
        if (!Array.isArray(data)) throw new SlotlineApiError(200, 'Slotline answered with no list of event types');
        return (data as Record<string, unknown>[])
            .filter((e) => typeof e['slug'] === 'string' && e['slug'] !== '' && typeof e['title'] === 'string')
            .map((e) => ({
                slug: e['slug'] as string,
                title: e['title'] as string,
                lengthInMinutes: typeof e['lengthInMinutes'] === 'number' ? e['lengthInMinutes'] : null,
                hidden: e['hidden'] === true,
            }));
    }

    /** One GET; Slotline's `{ status, data }` envelope opened. */
    private async get(baseUrl: string, apiKey: string, path: string, version?: string): Promise<unknown> {
        let response: Response;
        try {
            response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v2${path}`, {
                headers: {
                    authorization: `Bearer ${apiKey}`,
                    accept: 'application/json',
                    ...(version ? { 'cal-api-version': version } : {}),
                },
                signal: AbortSignal.timeout(SLOTLINE_API_TIMEOUT_MS),
            });
        } catch (error) {
            const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network';
            throw new SlotlineApiError(null, `Slotline did not answer (${reason})`);
        }
        let body: unknown;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        if (!response.ok) throw new SlotlineApiError(response.status, `Slotline answered ${response.status}`);
        return (body as { data?: unknown } | null)?.data ?? null;
    }
}
