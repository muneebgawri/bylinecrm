import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import type {
    CreateInvoiceInput,
    DealInvoiceView,
    NewswireosDealWonDeliveryView,
    NewswireosDealWonPreview,
    NewswireosOwnershipDeliveryView,
    NewswireosOwnershipPreview,
    NewswireosPaymentReviewView,
    NewswireosPaymentView,
    NewswireosSettingsView,
    PutNewswireosSettingsInput,
} from './types';

/**
 * Invoices on a deal (INV-1, #206): a payment's reference, verified by NewswireOS before it counts; what NewswireOS
 * cannot decide waits for a person with `invoice:verify`. And the workspace's NewswireOS link (an admin's).
 */

const keys = {
    deal: (workspaceId: string, dealId: string) => ['w', workspaceId, 'invoices', dealId] as const,
    newswireos: (workspaceId: string) => ['w', workspaceId, 'integrations', 'newswireos'] as const,
    ownershipDeliveries: (workspaceId: string) =>
        ['w', workspaceId, 'integrations', 'newswireos', 'ownership-deliveries'] as const,
    dealWonDeliveries: (workspaceId: string) =>
        ['w', workspaceId, 'integrations', 'newswireos', 'deal-won-deliveries'] as const,
    payments: (workspaceId: string) => ['w', workspaceId, 'integrations', 'newswireos', 'payments'] as const,
    payment: (workspaceId: string, paymentId: string) => ['w', workspaceId, 'newswireos-payments', paymentId] as const,
};

const base = (workspaceId: string, dealId: string) => workspacePath(workspaceId, `/opportunities/${dealId}/invoices`);

export const invoices = {
    list: (workspaceId: string, dealId: string, signal?: AbortSignal) =>
        request<DealInvoiceView[]>('GET', base(workspaceId, dealId), { signal }),
    create: (workspaceId: string, dealId: string, input: CreateInvoiceInput) =>
        request<DealInvoiceView>('POST', base(workspaceId, dealId), { body: input }),
    verify: (workspaceId: string, dealId: string, id: string, note?: string) =>
        request<DealInvoiceView>('POST', `${base(workspaceId, dealId)}/${id}/verify`, { body: note ? { note } : {} }),
    reject: (workspaceId: string, dealId: string, id: string, reason: string) =>
        request<DealInvoiceView>('POST', `${base(workspaceId, dealId)}/${id}/reject`, { body: { reason } }),
    recheck: (workspaceId: string, dealId: string, id: string) =>
        request<DealInvoiceView>('POST', `${base(workspaceId, dealId)}/${id}/recheck`),
};

/** A deal's invoices; looked at again every few seconds while one is being verified. */
export function useDealInvoices(workspaceId: string, dealId: string) {
    return useQuery({
        queryKey: keys.deal(workspaceId, dealId),
        queryFn: ({ signal }) => invoices.list(workspaceId, dealId, signal),
        refetchInterval: (q) => (q.state.data?.some((i) => i.status === 'verifying') ? 3000 : false),
    });
}

type InvoiceAction =
    | { kind: 'create'; input: CreateInvoiceInput }
    | { kind: 'verify'; id: string; note?: string }
    | { kind: 'reject'; id: string; reason: string }
    | { kind: 'recheck'; id: string };

export function useInvoiceAction(workspaceId: string, dealId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (action: InvoiceAction) => {
            switch (action.kind) {
                case 'create':
                    return invoices.create(workspaceId, dealId, action.input);
                case 'verify':
                    return invoices.verify(workspaceId, dealId, action.id, action.note);
                case 'reject':
                    return invoices.reject(workspaceId, dealId, action.id, action.reason);
                case 'recheck':
                    return invoices.recheck(workspaceId, dealId, action.id);
            }
        },
        onSuccess: () => {
            void client.invalidateQueries({ queryKey: keys.deal(workspaceId, dealId) });
            void client.invalidateQueries({ queryKey: ['w', workspaceId, 'notifications'], exact: false });
        },
    });
}

const newswireos = {
    get: (workspaceId: string, signal?: AbortSignal) =>
        request<NewswireosSettingsView>('GET', workspacePath(workspaceId, '/integrations/newswireos'), { signal }),
    put: (workspaceId: string, input: PutNewswireosSettingsInput) =>
        request<NewswireosSettingsView>('PUT', workspacePath(workspaceId, '/integrations/newswireos'), { body: input }),
    rotate: (workspaceId: string) =>
        request<NewswireosSettingsView>('POST', workspacePath(workspaceId, '/integrations/newswireos/rotate')),
    remove: (workspaceId: string) => request<void>('DELETE', workspacePath(workspaceId, '/integrations/newswireos')),
    setOwnershipPush: (workspaceId: string, enabled: boolean) =>
        request<NewswireosSettingsView>('PUT', workspacePath(workspaceId, '/integrations/newswireos/ownership-push'), {
            body: { enabled },
        }),
    ownershipDeliveries: (workspaceId: string, signal?: AbortSignal) =>
        request<NewswireosOwnershipDeliveryView[]>(
            'GET',
            workspacePath(workspaceId, '/integrations/newswireos/ownership-push/deliveries'),
            { signal },
        ),
    testOwnershipPush: (workspaceId: string) =>
        request<NewswireosOwnershipPreview>(
            'POST',
            workspacePath(workspaceId, '/integrations/newswireos/ownership-push/test'),
        ),
    setDealWonPush: (workspaceId: string, enabled: boolean) =>
        request<NewswireosSettingsView>('PUT', workspacePath(workspaceId, '/integrations/newswireos/deal-won-push'), {
            body: { enabled },
        }),
    dealWonDeliveries: (workspaceId: string, signal?: AbortSignal) =>
        request<NewswireosDealWonDeliveryView[]>(
            'GET',
            workspacePath(workspaceId, '/integrations/newswireos/deal-won-push/deliveries'),
            { signal },
        ),
    testDealWonPush: (workspaceId: string) =>
        request<NewswireosDealWonPreview>(
            'POST',
            workspacePath(workspaceId, '/integrations/newswireos/deal-won-push/test'),
        ),
};

export const useNewswireosSettings = (workspaceId: string) =>
    useQuery({ queryKey: keys.newswireos(workspaceId), queryFn: ({ signal }) => newswireos.get(workspaceId, signal) });

function useNewswireosWrite<I>(workspaceId: string, write: (input: I) => Promise<NewswireosSettingsView | void>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: write,
        onSuccess: (view) =>
            view
                ? client.setQueryData(keys.newswireos(workspaceId), view)
                : client.invalidateQueries({ queryKey: keys.newswireos(workspaceId) }),
    });
}

export const usePutNewswireos = (workspaceId: string) =>
    useNewswireosWrite(workspaceId, (input: PutNewswireosSettingsInput) => newswireos.put(workspaceId, input));
export const useRotateNewswireos = (workspaceId: string) =>
    useNewswireosWrite(workspaceId, () => newswireos.rotate(workspaceId));
export const useRemoveNewswireos = (workspaceId: string) =>
    useNewswireosWrite(workspaceId, () => newswireos.remove(workspaceId));

/** PNW-765: push completed ownership transfers to NewswireOS, or stop. */
export const useSetOwnershipPush = (workspaceId: string) =>
    useNewswireosWrite(workspaceId, (enabled: boolean) => newswireos.setOwnershipPush(workspaceId, enabled));

/** PNW-765: the latest ownership changes pushed to NewswireOS; looked at again while one is still going. */
export const useOwnershipDeliveries = (workspaceId: string) =>
    useQuery({
        queryKey: keys.ownershipDeliveries(workspaceId),
        queryFn: ({ signal }) => newswireos.ownershipDeliveries(workspaceId, signal),
        refetchInterval: (q) =>
            q.state.data?.some((d) => d.status === 'pending' || d.status === 'retrying') ? 5000 : false,
    });

/** PNW-765: the dry run. Nothing is sent; the body a push would send comes back. */
export const useTestOwnershipPush = (workspaceId: string) =>
    useMutation({ mutationFn: () => newswireos.testOwnershipPush(workspaceId) });

/** PNW-766: push won deals to NewswireOS, which makes their contacts clients, or stop. */
export const useSetDealWonPush = (workspaceId: string) =>
    useNewswireosWrite(workspaceId, (enabled: boolean) => newswireos.setDealWonPush(workspaceId, enabled));

/** PNW-766: the latest won deals pushed to NewswireOS; looked at again while one is still going. */
export const useDealWonDeliveries = (workspaceId: string) =>
    useQuery({
        queryKey: keys.dealWonDeliveries(workspaceId),
        queryFn: ({ signal }) => newswireos.dealWonDeliveries(workspaceId, signal),
        refetchInterval: (q) =>
            q.state.data?.some((d) => d.status === 'pending' || d.status === 'retrying') ? 5000 : false,
    });

/** PNW-766: the dry run. Nothing is sent; the body a push would send for the latest won deal that qualifies. */
export const useTestDealWonPush = (workspaceId: string) =>
    useMutation({ mutationFn: () => newswireos.testDealWonPush(workspaceId) });

/** INV-2: what a paid invoice NewswireOS reports does — `off`, `shadow` (record only) or `on`. */
export const useSetPaymentMode = (workspaceId: string) =>
    useNewswireosWrite(workspaceId, (mode: NewswireosSettingsView['paymentMode']) =>
        request<NewswireosSettingsView>('PUT', workspacePath(workspaceId, '/integrations/newswireos/payment-mode'), {
            body: { mode },
        }),
    );

/** INV-2: the latest paid invoices NewswireOS reported, beside what Account Managers entered (shadow's check). */
export const usePaymentReview = (workspaceId: string) =>
    useQuery({
        queryKey: keys.payments(workspaceId),
        queryFn: ({ signal }) =>
            request<NewswireosPaymentReviewView[]>(
                'GET',
                workspacePath(workspaceId, '/integrations/newswireos/payments'),
                { signal },
            ),
    });

/** INV-2: one reported payment, for the page its notification opens. */
export const usePayment = (workspaceId: string, paymentId: string) =>
    useQuery({
        queryKey: keys.payment(workspaceId, paymentId),
        queryFn: ({ signal }) =>
            request<NewswireosPaymentView>('GET', workspacePath(workspaceId, `/newswireos-payments/${paymentId}`), {
                signal,
            }),
    });

/** INV-2: puts a payment the CRM would not guess on the deal chosen; that deal's invoices refetch. */
export function useChoosePaymentDeal(workspaceId: string, paymentId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (opportunityId: string) =>
            request<NewswireosPaymentView>(
                'POST',
                workspacePath(workspaceId, `/newswireos-payments/${paymentId}/choose`),
                { body: { opportunityId } },
            ),
        onSuccess: (view) => {
            client.setQueryData(keys.payment(workspaceId, paymentId), view);
            if (view.opportunityId)
                void client.invalidateQueries({ queryKey: keys.deal(workspaceId, view.opportunityId) });
        },
    });
}
