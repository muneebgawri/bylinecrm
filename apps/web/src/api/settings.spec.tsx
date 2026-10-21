import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, keys } from './queries';
import { useOrderStages } from './settings';
import type { PipelineView } from './types';

const WS = '11111111-2222-4333-8444-555555555555';
const P = '24400e15-0000-4000-8000-0000000000f1';
const stage = (id: string, name: string, position: number) => ({ id, name, position });
const PIPELINE = {
    id: P,
    name: 'Sales pipeline',
    stages: [stage('s-new', 'New', 1), stage('s-contacted', 'Contacted', 2), stage('s-won', 'Won', 3)],
} as unknown as PipelineView;

function respond(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.restoreAllMocks());

describe('settings hooks', () => {
    it('FR-CRMS-UI-10: a stage reorder paints before the API answers, and the old order comes back on a refusal', async () => {
        const client = createQueryClient();
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        const key = [...keys.pipelines(WS), P] as const;
        client.setQueryData(key, PIPELINE);
        let release: (r: Response) => void = () => {};
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(
            new Promise<Response>((resolve) => {
                release = resolve;
            }),
        );
        const { result } = renderHook(() => useOrderStages(WS, P), { wrapper });
        const order = () =>
            client
                .getQueryData<PipelineView>(key)
                ?.stages.map((s: { id: string; position: number }) => [s.id, s.position]);

        act(() => {
            result.current.mutate(['s-contacted', 's-new', 's-won']);
        });
        // Painted at once, positions renumbered, while the request is still in flight.
        await waitFor(() =>
            expect(order()).toEqual([
                ['s-contacted', 1],
                ['s-new', 2],
                ['s-won', 3],
            ]),
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.current.isPending).toBe(true);

        // Later reads (the invalidation after settling) answer with the unchanged pipeline.
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(200, PIPELINE));
        release(
            respond(409, {
                statusCode: 409,
                code: 'conflict.stage_order',
                message: 'the stages changed',
                requestId: 'req-0123456789',
            }),
        );
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(order()).toEqual([
            ['s-new', 1],
            ['s-contacted', 2],
            ['s-won', 3],
        ]);
    });
});
