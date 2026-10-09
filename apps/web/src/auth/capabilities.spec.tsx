import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { MembershipSummary } from '../api/types';
import { CapabilitiesProvider, can, describeCapability, useCan, usePermission } from './capabilities';

const membership: MembershipSummary = {
    workspaceId: 'ws',
    memberId: 'm',
    roleId: 'r',
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
