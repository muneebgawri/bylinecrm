import type { Capability } from '@bylinecrm/shared';
import { createContext, useContext, type ReactNode } from 'react';
import type { MembershipSummary } from '../api/types';

/**
 * Permission-aware controls (FR-CRMS-UI-6) read the member's capabilities from here. The
 * provider is the swap point: the shell will fill it from the API once an endpoint returns the
 * current member's standing (see the design note); tests fill it directly. Until a membership
 * is known, nothing is allowed — a control is never shown on a guess. The server is still the
 * gate: this hook decides what to show, never what is permitted.
 */
const CapabilitiesContext = createContext<MembershipSummary | null>(null);

export interface CapabilitiesProviderProps {
    membership: MembershipSummary | null;
    children: ReactNode;
}

export function CapabilitiesProvider({ membership, children }: CapabilitiesProviderProps) {
    return <CapabilitiesContext.Provider value={membership}>{children}</CapabilitiesContext.Provider>;
}

/** The current membership, or `null` while unknown (outside a workspace, or still loading). */
export function useMembership(): MembershipSummary | null {
    return useContext(CapabilitiesContext);
}

/** The pure rule, exported so non-React code (the command registry's `when`) shares it. */
export function can(membership: MembershipSummary | null, capability: Capability): boolean {
    return membership !== null && membership.capabilities.includes(capability);
}

export function useCan(capability: Capability): boolean {
    return can(useMembership(), capability);
}

export interface Permission {
    allowed: boolean;
    /** Why a control is disabled — the tooltip's text (FR-CRMS-UI-6). Empty when allowed. */
    reason: string;
}

/** The capability's human name for the reason text; one wording, from the catalogue's own id. */
export function describeCapability(capability: Capability): string {
    const [subject = '', verb = ''] = capability.split(':');
    return `${verb.replace('_', ' ')} ${subject === 'workspace' ? 'the workspace' : `${subject}s`}`;
}

export function usePermission(capability: Capability): Permission {
    const allowed = useCan(capability);
    return { allowed, reason: allowed ? '' : `Your role cannot ${describeCapability(capability)}.` };
}
