import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlotlineApiError } from './slotline-api.port';
import { SlotlineApiHttp } from './slotline-api.http';

const BASE = 'https://bookings.example.com';
const KEY = 'cal_live_0123456789abcdef';

function answer(status: number, body: unknown) {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: RequestInit) => {
            seen.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
            return Promise.resolve(new Response(JSON.stringify(body), { status }));
        }),
    );
    return seen;
}

describe('#196 SlotlineApiHttp (Slotline’s v2 API through the booking site’s /api/v2)', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('me: the key as a bearer token, the username back', async () => {
        const seen = answer(200, { status: 'success', data: { id: 7, username: 'mia', email: 'mia@example.com' } });
        expect(await new SlotlineApiHttp().me(`${BASE}/`, KEY)).toEqual({ username: 'mia' });
        expect(seen[0]!.url).toBe(`${BASE}/api/v2/me`);
        expect(seen[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
    });

    it('eventTypes: the 2024-06-14 version, every event type of the key’s owner, hidden ones too', async () => {
        const seen = answer(200, {
            status: 'success',
            data: [
                { id: 1, slug: 'intro', title: 'Intro call', lengthInMinutes: 30, hidden: false, description: 'x' },
                { id: 2, slug: 'vip', title: 'VIP', lengthInMinutes: 15, hidden: true },
                { id: 3, title: 'no slug' },
            ],
        });
        expect(await new SlotlineApiHttp().eventTypes(BASE, KEY)).toEqual([
            { slug: 'intro', title: 'Intro call', lengthInMinutes: 30, hidden: false },
            { slug: 'vip', title: 'VIP', lengthInMinutes: 15, hidden: true },
        ]);
        expect(seen[0]!.url).toBe(`${BASE}/api/v2/event-types`);
        expect(seen[0]!.headers['cal-api-version']).toBe('2024-06-14');
    });

    it('a refused key is a 401, and the key is never in the message', async () => {
        answer(401, { status: 'error', error: { message: `Invalid API key ${KEY}` } });
        const error = await new SlotlineApiHttp().me(BASE, KEY).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SlotlineApiError);
        expect((error as SlotlineApiError).status).toBe(401);
        expect((error as SlotlineApiError).refused).toBe(true);
        expect((error as SlotlineApiError).message).not.toContain(KEY);
    });

    it('no answer is a status-less error', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))));
        const error = await new SlotlineApiHttp().eventTypes(BASE, KEY).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SlotlineApiError);
        expect((error as SlotlineApiError).status).toBeNull();
    });
});
