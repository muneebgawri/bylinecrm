import { Badge, Button, LoadingRegion, PageHeader, toast } from '@bylinecrm/ui';
import { Link } from 'react-router';
import { useChoosePaymentDeal, usePayment } from '../../../api/invoices';
import type { NewswireosPaymentView } from '../../../api/types';
import { RecordPicker } from '../../../components/RecordPicker';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';
import { formatMoney } from '../../../lib/money';
import { useWorkspaceId, usePaymentId } from '../../params';
import { paths } from '../../paths';

/**
 * INV-2: a paid invoice NewswireOS reported, from the notification that asks whose deal it is. A client with several
 * open deals is offered those; one the CRM does not know is put on any deal chosen. Once chosen, the payment is on
 * that deal as if it had been entered there, and verifies and moves the deal as any invoice does.
 */
export function PaymentPage() {
    const workspaceId = useWorkspaceId();
    const paymentId = usePaymentId();
    const payment = usePayment(workspaceId, paymentId);
    const choose = useChoosePaymentDeal(workspaceId, paymentId);
    const put = (opportunityId: string) =>
        choose.mutate(opportunityId, {
            onSuccess: (view) => toast({ title: `Payment put on ${view.opportunityName ?? 'the deal'}` }),
            onError: (e) => toast({ title: 'That did not work', description: failureText(e), tone: 'danger' }),
        });

    if (payment.isError) {
        return (
            <div className="p-7">
                <PageHeader title="Payment" />
                <p className="m-0 text-[13px] text-text-muted">{failureText(payment.error)}</p>
            </div>
        );
    }
    if (!payment.data) return <LoadingRegion label="Loading the payment" className="m-7 h-40" />;
    const p = payment.data;
    const waiting = p.mode === 'on' && !p.resolvedAt && (p.decision === 'needs_deal' || p.decision === 'unmatched');

    return (
        <div className="flex flex-col gap-5 p-7">
            <PageHeader
                title={`${p.clientName ?? 'A client'} paid ${p.invoiceNumber}`}
                subtitle={[formatMoney(p.amount), p.paymentMethod, p.occurredAt ? formatWhen(p.occurredAt) : null]
                    .filter(Boolean)
                    .join(' · ')}
            />
            {p.opportunityId ? (
                <section className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-[13px]">
                    <span className="flex items-center gap-2">
                        <Badge status="success">On a deal</Badge>
                        <Link className="font-medium text-text underline" to={paths.deal(workspaceId, p.opportunityId)}>
                            {p.opportunityName ?? 'Open the deal'}
                        </Link>
                    </span>
                    <span className="text-text-muted">{onDealLine(p)}</span>
                </section>
            ) : waiting ? (
                <section
                    aria-labelledby="payment-choose-title"
                    className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-[13px]"
                >
                    <h2 id="payment-choose-title" className="m-0 text-[14px] font-semibold text-text">
                        Which deal is this payment for?
                    </h2>
                    <p className="m-0 text-text-muted">
                        {p.decision === 'needs_deal'
                            ? `${p.clientName ?? 'This client'} has more than one open deal, so the CRM did not guess. Choose the one this invoice paid for.`
                            : `NewswireOS reported this payment from ${p.clientEmail ?? 'a client'}, who is not in the CRM. Choose the deal it paid for.`}{' '}
                        It is then verified with NewswireOS and moves the deal as an invoice entered there would.
                    </p>
                    {p.candidates.length > 0 ? (
                        <ul aria-label="Open deals" className="m-0 flex list-none flex-col divide-y divide-border p-0">
                            {p.candidates.map((deal) => (
                                <li key={deal.id} className="flex items-center gap-3 py-2">
                                    <Link
                                        className="min-w-0 flex-1 truncate text-text underline"
                                        to={paths.deal(workspaceId, deal.id)}
                                    >
                                        {deal.name}
                                    </Link>
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        shape="square"
                                        loading={choose.isPending && choose.variables === deal.id}
                                        disabled={choose.isPending}
                                        onClick={() => put(deal.id)}
                                    >
                                        Put it on this deal
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="max-w-sm">
                            <RecordPicker
                                workspaceId={workspaceId}
                                object="opportunity"
                                label="Deal"
                                value={null}
                                placeholder="Choose a deal"
                                onChange={(id) => (id ? put(id) : undefined)}
                            />
                        </div>
                    )}
                </section>
            ) : (
                <p className="m-0 text-[13px] text-text-muted">
                    {p.mode === 'shadow'
                        ? 'Recorded in shadow mode: nothing was put on a deal.'
                        : 'This payment is not waiting for a deal.'}
                </p>
            )}
        </div>
    );
}

function onDealLine(p: NewswireosPaymentView): string {
    if (p.resolvedAt) return `Put on this deal by hand ${formatWhen(p.resolvedAt)}.`;
    switch (p.decision) {
        case 'already_on_deal':
            return 'An Account Manager had already entered this invoice on the deal.';
        case 'created_deal':
            return 'The client had no open deal, so this one was made for the payment.';
        case 'attached':
            return p.matchedBy === 'deal_id'
                ? 'The invoice was raised from this deal.'
                : 'This is the client’s only open deal.';
        default:
            return '';
    }
}
