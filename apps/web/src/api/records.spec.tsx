import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, keys } from './queries';
import { usePatchRecord, useRecord } from './records';

const WS = '11111111-2222-4333-8444-555555555555';
const ID = '0f1c7b1e-2a2b-4c3d-8e4f-5a6b7c8d9e0f';
const person = { id: ID, nameFirst: 'Dana', nameLast: 'Reyes', city: 'Austin' };

function respond(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup() {
    const client = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { client, wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe('record hooks', () => {
    it('reads a record from its workspace route', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(200, person));
        const { wrapper } = setup();
        const { result } = renderHook(() => useRecord(WS, 'person', ID), { wrapper });
        await waitFor(() => expect(result.current.data).toEqual(person));
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/w/${WS}/people/${ID}`);
    });

    it('shows a patch at once and puts the old value back when the API refuses it', async () => {
        const { client, wrapper } = setup();
        client.setQueryData(keys.record(WS, 'person', ID), person);
        let release: (r: Response) => void = () => {};
        vi.spyOn(globalThis, 'fetch').mockReturnValue(
            new Promise<Response>((resolve) => {
                release = resolve;
            }),
        );
        const { result } = renderHook(() => usePatchRecord(WS, 'person', ID), { wrapper });

        act(() => {
            result.current.mutate({ city: 'Toledo' });
        });
        await waitFor(() =>
            expect(client.getQueryData<typeof person>(keys.record(WS, 'person', ID))?.city).toBe('Toledo'),
        );

        // Later reads (the invalidation after settling) answer with the unchanged record.
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(200, person));
        release(
            respond(400, {
                statusCode: 400,
                code: 'validation.failed',
                message: 'city is too long',
                requestId: 'req-0123456789',
            }),
        );
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(client.getQueryData<typeof person>(keys.record(WS, 'person', ID))?.city).toBe('Austin');
    });
});
