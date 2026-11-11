import { Injectable } from '@nestjs/common';
import { QUO_API_BASE, QUO_API_VERSION, QUO_HTTP_TIMEOUT_MS } from './calls.constants';
import {
    QuoApiError,
    type QuoApi,
    type QuoCall,
    type QuoRecording,
    type QuoTranscript,
    type QuoUser,
    type QuoWebhook,
} from './quo.port';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;

/** Quo's REST API over `fetch` (CALL-1): the key in `Authorization`, the version header on every request. */
@Injectable()
export class QuoHttp implements QuoApi {
    async listUsers(apiKey: string): Promise<QuoUser[]> {
        const out: QuoUser[] = [];
        let after: string | null = null;
        do {
            const page: Json = await this.request(
                apiKey,
                'GET',
                `/users?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`,
            );
            for (const u of Array.isArray(page['data']) ? page['data'] : []) {
                if (!isObject(u) || typeof u['id'] !== 'string') continue;
                out.push({
                    id: u['id'],
                    email: str(u['email']),
                    firstName: str(u['firstName']),
                    lastName: str(u['lastName']),
                });
            }
            after = str(page['nextCursor']);
        } while (after);
        return out;
    }

    async createWebhook(
        apiKey: string,
        input: { url: string; events: readonly string[]; label: string },
    ): Promise<QuoWebhook> {
        const body = await this.request(apiKey, 'POST', '/webhooks', {
            url: input.url,
            events: [...input.events],
            label: input.label,
            resourceIds: ['*'],
            status: 'enabled',
        });
        const data = isObject(body['data']) ? body['data'] : body;
        const id = str(data['id']);
        const key = str(data['key']);
        if (!id || !key) throw new QuoApiError('unavailable', 'Quo created the webhook but gave no id or key');
        return { id, key };
    }

    async deleteWebhook(apiKey: string, id: string): Promise<void> {
        try {
            await this.request(apiKey, 'DELETE', `/webhooks/${encodeURIComponent(id)}`);
        } catch (e) {
            if (e instanceof QuoApiError && e.kind === 'not_found') return;
            throw e;
        }
    }

    async getCall(apiKey: string, callId: string): Promise<QuoCall | null> {
        let body: Json;
        try {
            body = await this.request(
                apiKey,
                'GET',
                `/calls/${encodeURIComponent(callId)}?include=summary&include=voicemail`,
            );
        } catch (e) {
            if (e instanceof QuoApiError && e.kind === 'not_found') return null;
            throw e;
        }
        const d = isObject(body['data']) ? body['data'] : body;
        const direction = d['direction'] === 'outgoing' ? 'outgoing' : 'incoming';
        const participants = (Array.isArray(d['participants']) ? d['participants'] : [])
            .filter(isObject)
            .flatMap((p) =>
                typeof p['phoneNumber'] === 'string'
                    ? [{ phoneNumber: p['phoneNumber'], actorId: str(p['actorId']) }]
                    : [],
            );
        const summary = isObject(d['summary'])
            ? { summary: strings(d['summary']['summary']), nextSteps: strings(d['summary']['nextSteps']) }
            : null;
        const voicemail = isObject(d['voicemail'])
            ? { recordingUrl: str(d['voicemail']['recordingUrl']), duration: num(d['voicemail']['duration']) }
            : null;
        return {
            id: str(d['id']) ?? callId,
            direction,
            status: str(d['status']) ?? 'unknown',
            phoneNumberId: str(d['phoneNumberId']),
            actorId: str(d['actorId']) ?? str(d['answeredBy']) ?? str(d['initiatedBy']),
            participants,
            createdAt: str(d['createdAt']) ?? new Date().toISOString(),
            answeredAt: str(d['answeredAt']),
            completedAt: str(d['completedAt']),
            duration: num(d['duration']),
            summary,
            voicemail,
        };
    }

    async listRecordings(apiKey: string, callId: string): Promise<QuoRecording[]> {
        const body = await this.request(apiKey, 'GET', `/calls/${encodeURIComponent(callId)}/recordings`);
        return (Array.isArray(body['data']) ? body['data'] : [])
            .filter(isObject)
            .flatMap((r) => (typeof r['url'] === 'string' ? [{ url: r['url'], duration: num(r['duration']) }] : []));
    }

    async listTranscripts(apiKey: string, callId: string): Promise<QuoTranscript[]> {
        const body = await this.request(apiKey, 'GET', `/calls/${encodeURIComponent(callId)}/transcripts`);
        const items = Array.isArray(body['data']) ? body['data'] : isObject(body['data']) ? [body['data']] : [];
        return items.filter(isObject).map((t) => ({
            dialogue: (Array.isArray(t['dialogue']) ? t['dialogue'] : []).filter(isObject).map((l) => ({
                userId: str(l['userId']),
                content: str(l['content']) ?? '',
                start: num(l['start']) ?? 0,
                end: num(l['end']) ?? 0,
            })),
        }));
    }

    private async request(
        apiKey: string,
        method: 'GET' | 'POST' | 'DELETE',
        path: string,
        body?: unknown,
    ): Promise<Json> {
        let response: Response;
        try {
            response = await fetch(`${QUO_API_BASE}${path}`, {
                method,
                headers: {
                    authorization: apiKey,
                    'quo-api-version': QUO_API_VERSION,
                    accept: 'application/json',
                    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
                },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(QUO_HTTP_TIMEOUT_MS),
            });
        } catch (e) {
            throw new QuoApiError(
                'unavailable',
                `Quo could not be reached: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
        if (response.status === 401 || response.status === 403)
            throw new QuoApiError('unauthorized', 'Quo refused the API key');
        if (response.status === 404) throw new QuoApiError('not_found', 'Quo has no such thing');
        if (response.status === 429)
            throw new QuoApiError('rate_limited', 'Quo’s rate limit was reached; try again shortly');
        if (!response.ok) throw new QuoApiError('unavailable', `Quo answered ${response.status}`);
        if (response.status === 204) return {};
        const text = await response.text();
        if (text.trim() === '') return {};
        try {
            const parsed: unknown = JSON.parse(text);
            return isObject(parsed) ? parsed : {};
        } catch {
            throw new QuoApiError('unavailable', 'Quo answered with something other than JSON');
        }
    }
}
