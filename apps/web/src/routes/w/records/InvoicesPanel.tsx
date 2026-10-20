import { INVOICE_GATEWAYS, type InvoiceGateway } from '@bylinecrm/shared';
import {
    Badge,
    Button,
    Field,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    toast,
} from '@bylinecrm/ui';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError, fieldErrorAt } from '../../../api/client';
import { useDealInvoices, useInvoiceAction } from '../../../api/invoices';
import type { DealInvoiceView, OpportunityView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { failureText } from '../../../lib/errors';
import { formatMoney, parseMoneyInput, toMajor } from '../../../lib/money';
import { RailCard, RailEmpty, RailLoading } from './RailCard';

const GATEWAY_LABEL: Record<InvoiceGateway, string> = {
    stripe: 'Stripe',
    paypal: 'PayPal',
    crypto_onchain: 'Crypto (on-chain)',
    bank_wire: 'Bank transfer',
};

/** What each reason means, in words; any other is shown as NewswireOS sent it. */
const REASON_TEXT: Record<string, string> = {
    NO_LINK: 'No NewswireOS link: finance verifies it by hand.',
    AWAITING_BANK_CONFIRMATION: 'A bank transfer is confirmed by finance.',
    TOKEN_REFUSED: 'NewswireOS refused the CRM’s token.',
    TOKEN_LACKS_SCOPE: 'The CRM’s NewswireOS token lacks the payment_verification:lookup scope.',
    ALREADY_USED: 'Another release already holds this payment: finance decides if it is this deal’s.',
    UNDERPAID_WITHIN_TOLERANCE: 'Paid a little short, within the on-chain tolerance.',
    PROVIDER_ERROR: 'NewswireOS or the gateway did not answer.',
    UNDER_CONFIRMED: 'Not enough confirmations yet.',
    AMOUNT_MISMATCH: 'The amount or currency does not match.',
    NOT_FOUND: 'No such payment on the gateway.',
    NOT_SUCCEEDED: 'The payment did not succeed.',
    INVOICE_UNPAID: 'The invoice is not paid.',
    WRONG_PAYEE: 'Not paid to us.',
    REFUNDED: 'Refunded.',
    DISPUTED: 'Charged back or disputed.',
    MANUAL: 'Decided by hand.',
};

function statusBadge(invoice: DealInvoiceView) {
    switch (invoice.status) {
        case 'verifying':
            return <Badge status="neutral">Verifying…</Badge>;
        case 'verified':
            return invoice.refundedAmountMinor !== '0' ? (
                <Badge status="warning">Partially refunded</Badge>
            ) : (
                <Badge status="success">Verified</Badge>
            );
        case 'invalid':
            return <Badge status="danger">Refused</Badge>;
        case 'needs_review':
            return <Badge status="warning">Waiting for finance</Badge>;
        case 'invalidated':
            return <Badge status="danger">{invoice.reasonCode === 'DISPUTED' ? 'Charged back' : 'Refunded'}</Badge>;
    }
}

/**
 * The deal's invoices (INV-1, FR-CRMS-19): a payment's reference, checked against the gateway by NewswireOS
 * before it counts. Only a verified one counts; a refused one says why; one NewswireOS cannot decide waits for
 * finance, who verify or refuse it here (`invoice:verify`).
 */
export function InvoicesPanel({ workspaceId, deal }: { workspaceId: string; deal: OpportunityView }) {
    const list = useDealInvoices(workspaceId, deal.id);
    const edit = usePermission('deal:edit');
    const [adding, setAdding] = useState(false);
    return (
        <RailCard
            title="Invoices"
            count={list.data?.length}
            action={
                edit.allowed ? (
                    <Button size="xs" shape="square" variant="ghost" onClick={() => setAdding((a) => !a)}>
                        <Plus className="size-3.5" />
                        Add
                    </Button>
                ) : undefined
            }
        >
            {adding && <AddInvoice workspaceId={workspaceId} deal={deal} onDone={() => setAdding(false)} />}
            {list.isPending ? (
                <RailLoading />
            ) : list.isError ? (
                <RailEmpty>The invoices could not be loaded.</RailEmpty>
            ) : list.data.length === 0 ? (
                <RailEmpty>No invoices. Add a payment’s reference to verify it.</RailEmpty>
            ) : (
                <ul className="m-0 list-none p-0">
                    {list.data.map((invoice) => (
                        <InvoiceRow key={invoice.id} workspaceId={workspaceId} invoice={invoice} />
                    ))}
                </ul>
            )}
        </RailCard>
    );
}

function InvoiceRow({ workspaceId, invoice }: { workspaceId: string; invoice: DealInvoiceView }) {
    const verify = usePermission('invoice:verify');
    const edit = usePermission('deal:edit');
    const action = useInvoiceAction(workspaceId, invoice.opportunityId);
    const [rejecting, setRejecting] = useState(false);
    const [reason, setReason] = useState('');
    const undecided = invoice.status === 'needs_review' || invoice.status === 'verifying';
    const failed = (e: unknown) => toast({ title: 'That did not work', description: failureText(e), tone: 'danger' });
    const refunded = Number(invoice.refundedAmountMinor);
    const amount = formatMoney({ amountMinor: Number(invoice.amountMinor), currency: invoice.currency });
    // A partially refunded invoice counts net of the refund.
    const net =
        invoice.status === 'verified' && refunded > 0
            ? formatMoney({ amountMinor: Number(invoice.amountMinor) - refunded, currency: invoice.currency })
            : null;
    const why = invoice.reasonCode ? (REASON_TEXT[invoice.reasonCode] ?? invoice.reasonCode) : null;

    return (
        <li className="flex flex-col gap-1.5 border-t border-border px-4 py-3 first:border-t-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-xs" title={invoice.reference}>
                    {invoice.reference}
                </span>
                {statusBadge(invoice)}
            </div>
            <span className="text-xs text-text-muted">
                {GATEWAY_LABEL[invoice.gateway]} · {amount}
                {net && ` · ${net} after refunds`}
            </span>
            {why && (invoice.status !== 'verified' || invoice.reasonCode === 'UNDERPAID_WITHIN_TOLERANCE') && (
                <span className="text-xs text-text-muted">{why}</span>
            )}
            {invoice.note && <span className="text-xs text-text-muted">“{invoice.note}”</span>}
            {undecided && (verify.allowed || (edit.allowed && invoice.status === 'needs_review')) && (
                <div className="flex flex-wrap gap-1.5">
                    {verify.allowed && (
                        <>
                            <Button
                                size="xs"
                                shape="square"
                                variant="secondary"
                                disabled={action.isPending}
                                onClick={() => action.mutate({ kind: 'verify', id: invoice.id }, { onError: failed })}
                            >
                                Verify
                            </Button>
                            <Button
                                size="xs"
                                shape="square"
                                variant="ghost"
                                disabled={action.isPending}
                                onClick={() => setRejecting((r) => !r)}
                            >
                                Refuse
                            </Button>
                        </>
                    )}
                    {edit.allowed && invoice.status === 'needs_review' && (
                        <Button
                            size="xs"
                            shape="square"
                            variant="ghost"
                            disabled={action.isPending}
                            onClick={() => action.mutate({ kind: 'recheck', id: invoice.id }, { onError: failed })}
                        >
                            Check again
                        </Button>
                    )}
                </div>
            )}
            {rejecting && (
                <form
                    className="flex gap-1.5"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (!reason.trim()) return;
                        action.mutate(
                            { kind: 'reject', id: invoice.id, reason: reason.trim() },
                            { onSuccess: () => setRejecting(false), onError: failed },
                        );
                    }}
                >
                    <Input
                        aria-label="Why it is refused"
                        placeholder="Why?"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        className="h-7 text-xs"
                    />
                    <Button size="xs" shape="square" type="submit" variant="primary" disabled={!reason.trim()}>
                        Refuse
                    </Button>
                </form>
            )}
        </li>
    );
}

function AddInvoice({ workspaceId, deal, onDone }: { workspaceId: string; deal: OpportunityView; onDone: () => void }) {
    const action = useInvoiceAction(workspaceId, deal.id);
    const [gateway, setGateway] = useState<InvoiceGateway>('stripe');
    const [reference, setReference] = useState('');
    const [amount, setAmount] = useState(deal.amount ? String(toMajor(deal.amount)) : '');
    const [local, setLocal] = useState<string | null>(null);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const money = amount.trim() ? parseMoneyInput(amount, deal.currency) : null;
        if (!reference.trim()) return setLocal('Enter the payment’s reference.');
        if (amount.trim() && (!money || money.amountMinor <= 0)) return setLocal('Enter the amount paid.');
        if (!money && !deal.amount) return setLocal('The deal has no amount: enter the amount paid.');
        setLocal(null);
        const partial = money && (!deal.amount || money.amountMinor !== deal.amount.amountMinor);
        action.mutate(
            {
                kind: 'create',
                input: {
                    gateway,
                    reference: reference.trim(),
                    ...(partial ? { expectedAmountMinor: String(money.amountMinor) } : {}),
                },
            },
            {
                onSuccess: () => {
                    toast({ title: 'Invoice added', description: 'It is being verified.' });
                    onDone();
                },
                onError: (e) => {
                    if (e instanceof ApiError && e.status === 409) setLocal('This payment is already on a deal.');
                    else if (!(e instanceof ApiError) || e.fieldErrors.length === 0)
                        toast({ title: 'The invoice was not added', description: failureText(e), tone: 'danger' });
                },
            },
        );
    };

    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-2 border-b border-border px-4 py-3">
            <Field label="Paid with">
                <Select value={gateway} onValueChange={(v) => setGateway(v as InvoiceGateway)}>
                    <SelectTrigger aria-label="Paid with">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {INVOICE_GATEWAYS.map((g) => (
                            <SelectItem key={g} value={g}>
                                {GATEWAY_LABEL[g]}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Field>
            <Field
                label="Reference"
                hint="A Stripe pi_/ch_/in_ id, a PayPal capture or invoice number, a transaction hash."
                error={local ?? fieldErrorAt(action.error, 'reference')}
            >
                <Input
                    autoComplete="off"
                    spellCheck={false}
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                />
            </Field>
            <Field
                label={`Amount paid (${deal.currency})`}
                hint="The deal’s amount; less for a partial payment."
                error={fieldErrorAt(action.error, 'expectedAmountMinor')}
            >
                <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <div className="flex gap-2">
                <Button type="submit" size="sm" shape="square" variant="primary" loading={action.isPending}>
                    Verify payment
                </Button>
                <Button type="button" size="sm" shape="square" variant="ghost" onClick={onDone}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
