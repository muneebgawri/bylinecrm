import { useParams } from 'react-router';

/**
 * Route parameters, typed. `useParams` is untyped and a renamed segment passes the compiler while
 * every reader breaks; this is the one place a segment's name is spelled, and a missing value is
 * an error at the call site rather than `undefined` three components later.
 */
export const WORKSPACE_PARAM = 'workspaceId';

export function useWorkspaceId(): string {
    const value = useParams()[WORKSPACE_PARAM];
    if (!value) throw new Error(`route has no :${WORKSPACE_PARAM} segment`);
    return value;
}

/** The pipeline settings page's segment (P1-UI-8). */
export const PIPELINE_PARAM = 'pipelineId';

export function usePipelineId(): string {
    const value = useParams()[PIPELINE_PARAM];
    if (!value) throw new Error(`route has no :${PIPELINE_PARAM} segment`);
    return value;
}

/** The unsubscribe page's segment: the link's token (P3-1). */
export const UNSUBSCRIBE_TOKEN_PARAM = 'token';

export function useUnsubscribeToken(): string {
    const value = useParams()[UNSUBSCRIBE_TOKEN_PARAM];
    if (!value) throw new Error(`route has no :${UNSUBSCRIBE_TOKEN_PARAM} segment`);
    return value;
}

/** A sending domain's page segment (#190). */
export const DOMAIN_PARAM = 'domainId';

export function useDomainId(): string {
    const value = useParams()[DOMAIN_PARAM];
    if (!value) throw new Error(`route has no :${DOMAIN_PARAM} segment`);
    return value;
}

/** A reported payment's page segment (INV-2). */
export const PAYMENT_PARAM = 'paymentId';

export function usePaymentId(): string {
    const value = useParams()[PAYMENT_PARAM];
    if (!value) throw new Error(`route has no :${PAYMENT_PARAM} segment`);
    return value;
}
