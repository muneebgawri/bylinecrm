import type { Capability } from '@bylinecrm/shared';
import { createContext, useContext, type ReactNode } from 'react';
import { useMembershipQuery } from '../api/queries';
import type { MembershipSummary } from '../api/types';

/**
 * Permission-aware controls (FR-CRMS-UI-6) read the caller's capabilities from here. Until a
 * membership is known, nothing is allowed — a control is never shown on a guess. The server is
 * still the gate: this hook decides what to show, never what is permitted.
 */
const CapabilitiesContext = createContext<MembershipSummary | null>(null);

export interface CapabilitiesProviderProps {
    membership: MembershipSummary | null;
    children: ReactNode;
}

/** Provides a known membership; tests and the workspace layout use it. */
export function CapabilitiesProvider({ membership, children }: CapabilitiesProviderProps) {
    return <CapabilitiesContext.Provider value={membership}>{children}</CapabilitiesContext.Provider>;
}

/**
 * Fills the provider from `GET /w/:id/me` for the workspace routes. While loading, or if the
 * request fails, the membership is unknown and controls stay hidden; the route's own error
 * handling reports the failure — a permission read never decides what the page shows.
 */
export function WorkspaceCapabilities({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
    const query = useMembershipQuery(workspaceId);
    return <CapabilitiesProvider membership={query.data ?? null}>{children}</CapabilitiesProvider>;
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
