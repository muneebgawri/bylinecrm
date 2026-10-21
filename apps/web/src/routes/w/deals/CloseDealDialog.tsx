import type { LostReason, Money } from '@bylinecrm/shared';
import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Field,
    Input,
    Textarea,
} from '@bylinecrm/ui';
import { useId, useState, type FormEvent } from 'react';
import type { MoveDealInput, OpportunityView, StageView } from '../../../api/types';
import { formatMoney, parseMoneyInput } from '../../../lib/money';
import { LostReasonSelect } from './LostReasonSelect';

/** What the API's close takes: the won amount, or the lost reason. */
export type ClosePayload = NonNullable<MoveDealInput['close']>;

export interface CloseRequest {
    deal: OpportunityView;
    stage: StageView;
}

export interface CloseDealDialogProps {
    request: CloseRequest | null;
    busy: boolean;
    onCancel: () => void;
    /** The close payload the API requires for a won or lost stage. */
    onConfirm: (close: ClosePayload) => void;
}

/**
 * Dropping a deal into a won or lost stage is a close (doc 50 §B): the won amount (prefilled from
 * the deal) or the lost reason is asked for BEFORE the server is asked; cancel moves nothing.
 */
export function CloseDealDialog({ request, busy, onCancel, onConfirm }: CloseDealDialogProps) {
    const open = request !== null;
    return (
        <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
            <DialogContent aria-describedby={undefined}>
                {request && (
                    <CloseForm
                        key={request.deal.id}
                        request={request}
                        busy={busy}
                        onConfirm={onConfirm}
                        onCancel={onCancel}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function CloseForm({ request, busy, onConfirm, onCancel }: CloseDealDialogProps & { request: CloseRequest }) {
    const { deal, stage } = request;
    const won = stage.kind === 'won';
    const currency = deal.amount?.currency ?? deal.currency;
    const [amountText, setAmountText] = useState(() => (deal.amount ? majorText(deal.amount) : ''));
    const [reasonCode, setReasonCode] = useState<LostReason | ''>('');
    const [reason, setReason] = useState('');
    const [error, setError] = useState<string | null>(null);
    const formId = useId();

    function submit(event: FormEvent) {
        event.preventDefault();
        if (won) {
            const parsed = amountText.trim() ? parseMoneyInput(amountText, currency) : null;
            if (amountText.trim() && !parsed) {
                setError('Enter an amount, like 12000 or 12,000.50.');
                return;
            }
            onConfirm(parsed ? { wonAmount: parsed } : {});
        } else {
            if (!reasonCode) {
                setError('Pick why it was lost; the reason is kept with the deal.');
                return;
            }
            onConfirm({ lostReasonCode: reasonCode, ...(reason.trim() ? { lostReason: reason.trim() } : {}) });
        }
    }

    return (
        // noValidate: the form says what is missing in its own words, attached to the field (not the browser's bubble).
        <form id={formId} onSubmit={submit} noValidate className="contents">
            <DialogTitle>{won ? `Mark “${deal.name}” as won` : `Mark “${deal.name}” as lost`}</DialogTitle>
            <DialogDescription>
                {won
                    ? `The deal moves to ${stage.name} and closes. The amount below replaces the deal's amount.`
                    : `The deal moves to ${stage.name} and closes. The reason is recorded in its history.`}
            </DialogDescription>
            <DialogBody>
                {won ? (
                    <Field
                        label={`Won amount (${currency})`}
                        hint={deal.amount ? `Currently ${formatMoney(deal.amount)}` : 'Leave empty to keep no amount'}
                        error={error}
                    >
                        <Input
                            inputMode="decimal"
                            value={amountText}
                            onChange={(e) => {
                                setAmountText(e.target.value);
                                setError(null);
                            }}
                            autoFocus
                        />
                    </Field>
                ) : (
                    <div className="flex flex-col gap-3">
                        <Field label="Lost reason" required error={error}>
                            <LostReasonSelect
                                value={reasonCode}
                                onChange={(r) => {
                                    setReasonCode(r);
                                    setError(null);
                                }}
                            />
                        </Field>
                        <Field label="Details" hint="Optional">
                            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
                        </Field>
                    </div>
                )}
            </DialogBody>
            <DialogFooter>
                <Button type="button" variant="secondary" shape="square" onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
                <Button type="submit" variant="primary" shape="square" loading={busy}>
                    {won ? 'Mark as won' : 'Mark as lost'}
                </Button>
            </DialogFooter>
        </form>
    );
}

/** The deal's amount as the person would type it: "12000.5" for 1200050 minor units. */
function majorText(money: Money): string {
    const digits =
        new Intl.NumberFormat(undefined, { style: 'currency', currency: money.currency }).resolvedOptions()
            .maximumFractionDigits ?? 2;
    return (money.amountMinor / 10 ** digits).toString();
}
