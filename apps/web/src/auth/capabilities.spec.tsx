import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../api/queries';
import type { MembershipSummary } from '../api/types';
import {
    CapabilitiesProvider,
    WorkspaceCapabilities,
    can,
    describeCapability,
    useCan,
    usePermission,
} from './capabilities';

const membership: MembershipSummary = {
    memberId: 'm',
    workspaceId: 'w1',
    apiKeyId: null,
    userId: 'u',
    roleId: 'r',
    roleName: 'member',
    recordScope: 'all',
    capabilities: ['record:read', 'deal:move'],
};

const withMembership = (value: MembershipSummary | null) =>
    function Wrapper({ children }: { children: ReactNode }) {
        return <CapabilitiesProvider membership={value}>{children}</CapabilitiesProvider>;
    };

describe('useCan', () => {
    it('allows nothing until a membership is known', () => {
        const { result } = renderHook(() => useCan('record:read'), { wrapper: withMembership(null) });
        expect(result.current).toBe(false);
    });

    it('answers from the membership, and only from it', () => {
        const { result: read } = renderHook(() => useCan('record:read'), { wrapper: withMembership(membership) });
        const { result: admin } = renderHook(() => useCan('workspace:admin'), { wrapper: withMembership(membership) });
        expect(read.current).toBe(true);
        expect(admin.current).toBe(false);
    });

    it('gives a disabled control its reason', () => {
        const { result } = renderHook(() => usePermission('deal:bulk'), { wrapper: withMembership(membership) });
        expect(result.current).toEqual({ allowed: false, reason: 'Your role cannot bulk deals.' });
    });
});

describe('WorkspaceCapabilities', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('allows nothing until GET /w/:id/me answers, then answers from it', async () => {
        const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(membership), { status: 200 })));
        vi.stubGlobal('fetch', fetchMock);
        const client = createQueryClient();
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>
                <WorkspaceCapabilities workspaceId="ws-1">{children}</WorkspaceCapabilities>
            </QueryClientProvider>
        );
        const { result } = renderHook(() => useCan('deal:move'), { wrapper });
        expect(result.current).toBe(false);
        await waitFor(() => expect(result.current).toBe(true));
        expect(fetchMock).toHaveBeenCalledWith('/api/w/ws-1/me', expect.anything());
    });
});

describe('can and describeCapability', () => {
    it('is the same rule outside React', () => {
        expect(can(membership, 'deal:move')).toBe(true);
        expect(can(null, 'deal:move')).toBe(false);
    });

    it('names a capability in words', () => {
        expect(describeCapability('template:send_test')).toBe('send test templates');
        expect(describeCapability('workspace:admin')).toBe('admin the workspace');
    });
});
