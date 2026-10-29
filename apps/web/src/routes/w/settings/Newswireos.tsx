import {
    Badge,
    Button,
    Field,
    Input,
    LoadingRegion,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    toast,
} from '@bylinecrm/ui';
import { Link } from 'react-router';
import { useState, type FormEvent } from 'react';
import { ApiError, fieldErrorAt } from '../../../api/client';
import {
    useDealWonDeliveries,
    useNewswireosSettings,
    useOwnershipDeliveries,
    usePaymentReview,
    usePutNewswireos,
    useRemoveNewswireos,
    useRotateNewswireos,
    useSetDealWonPush,
    useSetOwnershipPush,
    useSetPaymentMode,
    useTestDealWonPush,
    useTestOwnershipPush,
} from '../../../api/invoices';
import type {
    NewswireosDealWonDeliveryView,
    NewswireosDealWonPreview,
    NewswireosOwnershipDeliveryView,
    NewswireosOwnershipPreview,
    NewswireosPaymentReviewView,
    NewswireosSettingsView,
} from '../../../api/types';
import { formatMoney } from '../../../lib/money';
import { paths } from '../../paths';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { CopyValue } from '../../../components/CopyValue';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { SETTINGS_SECTION_TITLE_ID } from './sectionTitle';

const RESULT_TEXT: Record<string, string> = {
    applied: 'A refund or chargeback was applied to an invoice, or client activity was put on a timeline.',
    unmatched: 'A delivery arrived for no invoice or record in this workspace; it was kept.',
    ignored: 'A delivery the CRM does not read was acknowledged.',
    duplicate: 'NewswireOS redelivered an event already applied; it was acknowledged.',
    bad_signature: 'A delivery was refused: it was not signed with this secret.',
    no_secret: 'A delivery was refused: paste the secret NewswireOS made for this hook.',
};

/**
 * NewswireOS (INV-1): where invoices on deals are verified against the payment gateways, with an API token, and
 * the hook NewswireOS reports refunds and chargebacks to. Without a link, every invoice waits for a person who
 * may verify invoices.
 */
export function Newswireos() {
    const workspaceId = useWorkspaceId();
    const settings = useNewswireosSettings(workspaceId);
    if (settings.isError) throw settings.error;
    return (
        <section aria-labelledby={SETTINGS_SECTION_TITLE_ID} className="max-w-3xl">
            <p className="m-0 mb-5 max-w-[70ch] text-[13px] text-text-muted">
                An invoice entered on a deal is checked by NewswireOS against the gateway (Stripe, PayPal, on-chain)
                before it counts: paid, to us, for the right amount, and not refunded. Without a link, every invoice
                waits for someone whose role may verify invoices.
            </p>
            {settings.data ? (
                <NewswireosForm
                    key={JSON.stringify(settings.data)}
                    workspaceId={workspaceId}
                    settings={settings.data}
                />
            ) : (
                <LoadingRegion label="Loading NewswireOS settings" className="h-24" />
            )}
        </section>
    );
}

function NewswireosForm({ workspaceId, settings }: { workspaceId: string; settings: NewswireosSettingsView }) {
    const put = usePutNewswireos(workspaceId);
    const rotate = useRotateNewswireos(workspaceId);
    const remove = useRemoveNewswireos(workspaceId);
    const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? 'https://');
    const [apiToken, setApiToken] = useState('');
    const [secret, setSecret] = useState('');
    const [dashboardUrl, setDashboardUrl] = useState(settings.dashboardUrl ?? '');
    const [local, setLocal] = useState<{ baseUrl?: string; apiToken?: string; secret?: string; dashboardUrl?: string }>(
        {},
    );
    const [confirm, setConfirm] = useState<'rotate' | 'remove' | null>(null);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const errors: { baseUrl?: string; apiToken?: string; secret?: string; dashboardUrl?: string } = {};
        if (!/^https?:\/\/[^/\s]+/i.test(baseUrl.trim())) errors.baseUrl = 'Enter NewswireOS’s address.';
        if (!settings.configured && !apiToken) errors.apiToken = 'Enter a NewswireOS API token.';
        setLocal(errors);
        const dashboard = dashboardUrl.trim();
        if (dashboard && !/^https?:\/\/[^/\s]+\/[^\s]+/i.test(dashboard)) {
            errors.dashboardUrl = 'Enter the dashboard address with the workspace, https://…/your-workspace.';
        }
        if (errors.baseUrl || errors.apiToken || errors.secret || errors.dashboardUrl) return;
        put.mutate(
            {
                baseUrl: baseUrl.trim(),
                ...(apiToken ? { apiToken } : {}),
                ...(secret ? { secret } : {}),
                dashboardUrl: dashboard || null,
            },
            {
                onSuccess: () => toast({ title: settings.configured ? 'NewswireOS saved' : 'NewswireOS linked' }),
                onError: (e) => {
                    if (!(e instanceof ApiError) || e.fieldErrors.length === 0) {
                        toast({ title: 'NewswireOS was not saved', description: failureText(e), tone: 'danger' });
                    }
                },
            },
        );
    };

    return (
        <div className="flex flex-col gap-5">
            <form onSubmit={submit} noValidate className="flex flex-col gap-4">
                <Field
                    label="NewswireOS address"
                    hint="https://app.newswireos.example"
                    error={local.baseUrl ?? fieldErrorAt(put.error, 'baseUrl')}
                >
                    <Input
                        type="url"
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        className="max-w-[28rem]"
                    />
                </Field>
                <Field
                    label="API token"
                    hint={
                        settings.configured
                            ? 'Set. Enter a new one only to replace it.'
                            : 'A NewswireOS API token with the payment_verification:lookup scope (and crm:ownership_write to push ownership changes, crm:client_write to push won deals).'
                    }
                    error={local.apiToken ?? fieldErrorAt(put.error, 'apiToken')}
                >
                    <Input
                        type="password"
                        autoComplete="new-password"
                        value={apiToken}
                        onChange={(e) => setApiToken(e.target.value)}
                        className="max-w-[28rem]"
                    />
                </Field>
                <Field
                    label="Hook secret"
                    hint={
                        settings.secretSet
                            ? 'Set. Paste a new one only when NewswireOS makes a new one.'
                            : settings.configured
                              ? 'Add the hook URL below in NewswireOS, then paste the secret it shows you (whsec_…).'
                              : 'Leave empty for now: link first, add the hook URL in NewswireOS, then paste its secret here.'
                    }
                    error={local.secret ?? fieldErrorAt(put.error, 'secret')}
                >
                    <Input
                        type="password"
                        autoComplete="new-password"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                        className="max-w-[28rem]"
                    />
                </Field>
                <Field
                    label="Dashboard address"
                    hint="Where Account Managers raise invoices, with your workspace: https://dashboard.example/your-workspace. A deal’s “Raise invoice in NewswireOS” opens the client there, so the paid invoice comes back to that deal."
                    error={local.dashboardUrl ?? fieldErrorAt(put.error, 'dashboardUrl')}
                >
                    <Input
                        type="url"
                        inputMode="url"
                        value={dashboardUrl}
                        onChange={(e) => setDashboardUrl(e.target.value)}
                        className="max-w-[28rem]"
                    />
                </Field>
                <div className="flex flex-wrap gap-2">
                    <Button type="submit" variant="primary" shape="square" loading={put.isPending}>
                        {settings.configured ? 'Save' : 'Link NewswireOS'}
                    </Button>
                    {settings.configured && (
                        <Button type="button" variant="ghost" shape="square" onClick={() => setConfirm('remove')}>
                            Unlink
                        </Button>
                    )}
                </div>
            </form>

            {settings.configured && settings.hookUrl && (
                <section
                    aria-label="Hook for NewswireOS"
                    className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="m-0 text-[14px] font-semibold text-text">Refunds and chargebacks</h3>
                        {!settings.secretSet ? (
                            <Badge status="warning">Secret not set</Badge>
                        ) : settings.lastDeliveryResult === 'bad_signature' ? (
                            <Badge status="danger">Secret does not match</Badge>
                        ) : settings.lastDeliveryAt ? (
                            <Badge status="success">Receiving</Badge>
                        ) : (
                            <Badge status="neutral">Nothing received yet</Badge>
                        )}
                    </div>
                    <p className="m-0 flex flex-col gap-1 text-[13px]">
                        Give NewswireOS this URL, with the same secret:
                        <span className="flex flex-wrap items-center gap-2">
                            <code className="text-xs break-all">{settings.hookUrl}</code>
                            <CopyValue value={settings.hookUrl} label="Copy URL" />
                        </span>
                    </p>
                    <p className="m-0 text-[13px] text-text-muted">
                        {settings.lastDeliveryAt
                            ? `${RESULT_TEXT[settings.lastDeliveryResult ?? ''] ?? 'A delivery arrived.'} Last delivery ${formatWhen(settings.lastDeliveryAt)}.`
                            : 'A verified invoice that is refunded or charged back stops counting when NewswireOS says so. Client activity sent to the same URL (new clients, paid orders and invoices, distributions, account managers) goes on the matching person’s or company’s timeline.'}
                    </p>
                    <div>
                        <Button type="button" variant="secondary" shape="square" onClick={() => setConfirm('rotate')}>
                            New hook URL
                        </Button>
                    </div>
                </section>
            )}

            {settings.configured && <OwnershipPush workspaceId={workspaceId} settings={settings} />}
            {settings.configured && <DealWonPush workspaceId={workspaceId} settings={settings} />}
            {settings.configured && <PaidInvoices workspaceId={workspaceId} settings={settings} />}

            <ConfirmDialog
                open={confirm !== null}
                onOpenChange={(open) => !open && setConfirm(null)}
                title={confirm === 'rotate' ? 'Make a new hook URL?' : 'Unlink NewswireOS?'}
                body={
                    confirm === 'rotate'
                        ? 'The current URL stops working at once; give NewswireOS the new one.'
                        : 'New invoices wait for someone who may verify invoices. Invoices already decided stay.'
                }
                confirm={confirm === 'rotate' ? 'Make a new URL' : 'Unlink'}
                pending={rotate.isPending || remove.isPending}
                onConfirm={() => {
                    const done = (title: string) => () => {
                        setConfirm(null);
                        toast({ title });
                    };
                    const failed = (e: unknown) =>
                        toast({ title: 'That did not work', description: failureText(e), tone: 'danger' });
                    if (confirm === 'rotate')
                        rotate.mutate(undefined, { onSuccess: done('New hook URL made'), onError: failed });
                    else remove.mutate(undefined, { onSuccess: done('NewswireOS unlinked'), onError: failed });
                }}
            />
        </div>
    );
}

type DeliveryStatus = NewswireosOwnershipDeliveryView['status'];
const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; status: 'neutral' | 'success' | 'warning' | 'danger' }> =
    {
        pending: { label: 'Queued', status: 'neutral' },
        retrying: { label: 'Retrying', status: 'warning' },
        delivered: { label: 'Delivered', status: 'success' },
        not_ready: { label: 'NewswireOS not ready', status: 'warning' },
        failed: { label: 'Failed', status: 'danger' },
        skipped: { label: 'Not sent: push off', status: 'neutral' },
    };
/** What NewswireOS's codes (and the CRM's own) mean to an admin. */
const OUTCOME_TEXT: Record<string, string> = {
    TOKEN_LACKS_SCOPE:
        'Add the crm:ownership_write scope to the NewswireOS token (Settings → API tokens in NewswireOS).',
    TOKEN_REFUSED: 'NewswireOS refused the API token: enter a new one above.',
    BAD_REQUEST: 'NewswireOS could not read the change it was sent.',
    STALE: 'NewswireOS already has a later change for this record.',
    NO_AM_FOR_EMAIL: 'The new owner has no account manager in NewswireOS.',
    NO_CUSTOMER: 'No matching client in NewswireOS.',
    UNCHANGED: 'NewswireOS already had this owner.',
    AGENCY_CLIENT: 'An agency client: NewswireOS left its account manager alone.',
};
const REASON_TEXT: Record<NewswireosOwnershipDeliveryView['reason'], string> = {
    transfer: 'Transferred',
    forced: 'Moved by a manager',
    first_contact: 'Handed over on first contact',
};

/**
 * PNW-765: completed ownership transfers pushed to NewswireOS, so its account managers follow the CRM's owners.
 * Off by default; while off, nothing is sent. "Send test" sends nothing (NewswireOS reads no test flag yet): it
 * shows the body a push sends.
 */
function OwnershipPush({ workspaceId, settings }: { workspaceId: string; settings: NewswireosSettingsView }) {
    const set = useSetOwnershipPush(workspaceId);
    const test = useTestOwnershipPush(workspaceId);
    const deliveries = useOwnershipDeliveries(workspaceId);
    const [preview, setPreview] = useState<NewswireosOwnershipPreview | null>(null);
    const failed = (e: unknown) => toast({ title: 'That did not work', description: failureText(e), tone: 'danger' });
    return (
        <section
            aria-labelledby="newswireos-ownership-title"
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
        >
            <h3 id="newswireos-ownership-title" className="m-0 text-[14px] font-semibold text-text">
                Ownership changes
            </h3>
            <label className="flex items-start gap-3 text-[13px]">
                <Switch
                    checked={settings.pushOwnership}
                    disabled={set.isPending}
                    onCheckedChange={(on) =>
                        set.mutate(on, {
                            onSuccess: () => toast({ title: on ? 'Ownership push on' : 'Ownership push off' }),
                            onError: failed,
                        })
                    }
                />
                <span className="flex flex-col gap-0.5">
                    <span className="font-medium text-text">Push ownership changes to NewswireOS</span>
                    <span className="text-text-muted">
                        When a record changes hands here, its account manager in NewswireOS follows. The API token needs
                        the crm:ownership_write scope. Owners filled in by an import are not pushed, and nothing is sent
                        while this is off.
                    </span>
                </span>
            </label>
            <div>
                <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    loading={test.isPending}
                    onClick={() => test.mutate(undefined, { onSuccess: setPreview, onError: failed })}
                >
                    Send test
                </Button>
            </div>
            {preview && (
                <div className="flex flex-col gap-1 text-[13px]">
                    <p className="m-0 text-text-muted">
                        Nothing was sent: NewswireOS does not read a test flag yet. This is what a push sends:
                    </p>
                    <pre className="m-0 max-h-64 overflow-auto rounded-md border border-border p-3 text-xs break-all whitespace-pre-wrap">
                        {JSON.stringify(preview.payload, null, 2)}
                    </pre>
                </div>
            )}
            <h4 className="m-0 mt-2 text-[13px] font-semibold text-text">Recent deliveries</h4>
            {deliveries.isError ? (
                <p className="m-0 text-[13px] text-text-muted">{failureText(deliveries.error)}</p>
            ) : !deliveries.data ? (
                <LoadingRegion label="Loading deliveries" className="h-12" />
            ) : deliveries.data.length === 0 ? (
                <p className="m-0 text-[13px] text-text-muted">Nothing pushed yet.</p>
            ) : (
                <ul aria-label="Recent deliveries" className="m-0 flex list-none flex-col divide-y divide-border p-0">
                    {deliveries.data.map((d) => (
                        <DeliveryItem key={d.id} delivery={d} />
                    ))}
                </ul>
            )}
        </section>
    );
}

function DeliveryItem({ delivery: d }: { delivery: NewswireosOwnershipDeliveryView }) {
    const badge = DELIVERY_STATUS[d.status];
    const outcome =
        d.status === 'delivered'
            ? d.matched
                ? 'Matched in NewswireOS.'
                : (OUTCOME_TEXT[d.reasonCode ?? ''] ?? 'No matching client in NewswireOS.')
            : d.status === 'not_ready'
              ? 'NewswireOS does not take ownership changes yet; not retried.'
              : (OUTCOME_TEXT[d.reasonCode ?? ''] ?? d.lastError);
    return (
        <li className="flex flex-col gap-0.5 py-2 text-[13px]">
            <span className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 font-medium break-words">
                    {d.recordName || (d.recordType === 'company' ? 'A company' : 'A person')} → {d.newOwnerEmail}
                </span>
                <Badge status={badge.status}>{badge.label}</Badge>
            </span>
            <span className="text-xs text-text-muted">
                {REASON_TEXT[d.reason]} · {formatWhen(d.lastAttemptAt ?? d.createdAt)}
                {d.attempts > 1 ? ` · ${d.attempts} attempts` : ''}
                {d.reasonCode ? ` · ${d.reasonCode}` : ''}
            </span>
            {outcome && <span className="text-xs break-words text-text-muted">{outcome}</span>}
            {d.customers.length > 0 && (
                <span className="text-xs break-words text-text-muted">
                    {d.customers
                        .map((c) => `Customer ${c.customerId}${c.reasonCode ? `: ${c.reasonCode}` : ''}`)
                        .join(' · ')}
                </span>
            )}
        </li>
    );
}

/** What NewswireOS's answer to a won deal means to an admin (its codes, then the CRM's own as for ownership). */
const DEAL_WON_TEXT: Record<string, string> = {
    CREATED: 'A new client account was made in NewswireOS (no invitation is sent).',
    LINKED: 'Linked to the client account the contact already has.',
    COLLEAGUE: 'Added as a colleague of the company’s existing client.',
    AGENCY_CLIENT: 'Linked to an agency’s client: NewswireOS left its account manager alone.',
    NOT_A_CLIENT: 'The address is a NewswireOS staff account: nothing was made.',
    TOKEN_LACKS_SCOPE: 'Add the crm:client_write scope to the NewswireOS token (Settings → API tokens in NewswireOS).',
    TOKEN_REFUSED: 'NewswireOS refused the API token: enter a new one above.',
    BAD_REQUEST: 'NewswireOS could not read the deal it was sent.',
};

/**
 * PNW-766: won deals pushed to NewswireOS, which makes the deal's contact a client with the deal owner's account
 * manager. Off by default; while off, nothing is sent. "Send test" sends nothing: it shows the body a push would
 * send for the latest won deal that qualifies.
 */
function DealWonPush({ workspaceId, settings }: { workspaceId: string; settings: NewswireosSettingsView }) {
    const set = useSetDealWonPush(workspaceId);
    const test = useTestDealWonPush(workspaceId);
    const deliveries = useDealWonDeliveries(workspaceId);
    const [preview, setPreview] = useState<NewswireosDealWonPreview | null>(null);
    const failed = (e: unknown) => toast({ title: 'That did not work', description: failureText(e), tone: 'danger' });
    return (
        <section
            aria-labelledby="newswireos-deal-won-title"
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
        >
            <h3 id="newswireos-deal-won-title" className="m-0 text-[14px] font-semibold text-text">
                Won deals
            </h3>
            <label className="flex items-start gap-3 text-[13px]">
                <Switch
                    checked={settings.pushDealWon}
                    disabled={set.isPending}
                    onCheckedChange={(on) =>
                        set.mutate(on, {
                            onSuccess: () => toast({ title: on ? 'Won-deal push on' : 'Won-deal push off' }),
                            onError: failed,
                        })
                    }
                />
                <span className="flex flex-col gap-0.5">
                    <span className="font-medium text-text">Make won deals’ contacts NewswireOS clients</span>
                    <span className="text-text-muted">
                        When a deal is won here, its contact becomes a client in NewswireOS (or is linked to the client
                        they already are), with the deal owner as account manager. Only deals whose contact has an email
                        are sent. The API token needs the crm:client_write scope; nothing is sent while this is off.
                    </span>
                </span>
            </label>
            <div>
                <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    loading={test.isPending}
                    onClick={() => test.mutate(undefined, { onSuccess: setPreview, onError: failed })}
                >
                    Send test
                </Button>
            </div>
            {preview &&
                (preview.payload ? (
                    <div className="flex flex-col gap-1 text-[13px]">
                        <p className="m-0 text-text-muted">
                            Nothing was sent. This is what a push sends for the latest won deal that qualifies,{' '}
                            {preview.payload.deal.name || 'unnamed'}:
                        </p>
                        <pre className="m-0 max-h-64 overflow-auto rounded-md border border-border p-3 text-xs break-all whitespace-pre-wrap">
                            {JSON.stringify(preview.payload, null, 2)}
                        </pre>
                    </div>
                ) : (
                    <p className="m-0 text-[13px] text-text-muted">
                        Nothing was sent: no won deal qualifies yet. A deal qualifies when its contact has an email, and
                        it has a company and an owner (its own, or its contact’s).
                    </p>
                ))}
            <h4 className="m-0 mt-2 text-[13px] font-semibold text-text">Recent deliveries</h4>
            {deliveries.isError ? (
                <p className="m-0 text-[13px] text-text-muted">{failureText(deliveries.error)}</p>
            ) : !deliveries.data ? (
                <LoadingRegion label="Loading won-deal deliveries" className="h-12" />
            ) : deliveries.data.length === 0 ? (
                <p className="m-0 text-[13px] text-text-muted">Nothing pushed yet.</p>
            ) : (
                <ul
                    aria-label="Recent won-deal deliveries"
                    className="m-0 flex list-none flex-col divide-y divide-border p-0"
                >
                    {deliveries.data.map((d) => (
                        <DealWonItem key={d.id} delivery={d} />
                    ))}
                </ul>
            )}
        </section>
    );
}

function DealWonItem({ delivery: d }: { delivery: NewswireosDealWonDeliveryView }) {
    const badge = DELIVERY_STATUS[d.status];
    const outcome =
        d.status === 'not_ready'
            ? 'NewswireOS does not take won deals yet; not retried.'
            : (DEAL_WON_TEXT[d.reasonCode ?? ''] ?? d.lastError);
    return (
        <li className="flex flex-col gap-0.5 py-2 text-[13px]">
            <span className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 font-medium break-words">
                    {d.dealName || 'A deal'} · {d.contactEmail}
                </span>
                <Badge status={badge.status}>{badge.label}</Badge>
            </span>
            <span className="text-xs text-text-muted">
                Owner {d.ownerEmail} · {formatWhen(d.lastAttemptAt ?? d.createdAt)}
                {d.attempts > 1 ? ` · ${d.attempts} attempts` : ''}
                {d.reasonCode ? ` · ${d.reasonCode}` : ''}
                {d.amReasonCode ? ` · AM ${d.amReasonCode}` : ''}
            </span>
            {outcome && <span className="text-xs break-words text-text-muted">{outcome}</span>}
            {d.customerId && (
                <span className="text-xs break-words text-text-muted">
                    Customer {d.customerId}
                    {d.parentCustomerId ? ` · colleague of ${d.parentCustomerId}` : ''}
                </span>
            )}
        </li>
    );
}

const PAYMENT_MODES: Record<NewswireosSettingsView['paymentMode'], { label: string; help: string }> = {
    off: {
        label: 'Off',
        help: 'Paid invoices go on the client’s timeline only. Account Managers enter them on deals.',
    },
    shadow: {
        label: 'Shadow',
        help: 'Each paid invoice records the deal it would go on, and nothing else happens. Compare below with what Account Managers enter, then switch on.',
    },
    on: {
        label: 'On',
        help: 'Each paid invoice goes on the client’s deal as if an Account Manager had entered it, so it is verified and moves the deal by the invoice rule. With no open deal, one is made and its owner told; with several, the owner chooses.',
    },
};

const DECISION_TEXT: Record<NewswireosPaymentReviewView['decision'], string> = {
    already_on_deal: 'Already entered on',
    attached: 'On',
    created_deal: 'New deal',
    needs_deal: 'Owner to choose',
    unmatched: 'Client not in the CRM',
    pooled_elsewhere: 'Another workspace’s client (lead pool): not booked here',
};

/** INV-2: what a paid invoice NewswireOS reports does, and shadow's check against what Account Managers entered. */
function PaidInvoices({ workspaceId, settings }: { workspaceId: string; settings: NewswireosSettingsView }) {
    const set = useSetPaymentMode(workspaceId);
    const review = usePaymentReview(workspaceId);
    const compared = (review.data ?? []).filter((p) => p.agrees !== null);
    const agreed = compared.filter((p) => p.agrees).length;
    return (
        <section
            aria-labelledby="newswireos-payments-title"
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
        >
            <h3 id="newswireos-payments-title" className="m-0 text-[14px] font-semibold text-text">
                Paid invoices move deals
            </h3>
            <Field label="When NewswireOS reports a paid invoice" className="max-w-xs">
                <Select
                    value={settings.paymentMode}
                    disabled={set.isPending}
                    onValueChange={(mode) =>
                        set.mutate(mode as NewswireosSettingsView['paymentMode'], {
                            onSuccess: () => toast({ title: `Paid invoices: ${PAYMENT_MODES[mode as 'on'].label}` }),
                            onError: (e) =>
                                toast({ title: 'That did not work', description: failureText(e), tone: 'danger' }),
                        })
                    }
                >
                    <SelectTrigger aria-label="When NewswireOS reports a paid invoice">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {(Object.keys(PAYMENT_MODES) as NewswireosSettingsView['paymentMode'][]).map((m) => (
                            <SelectItem key={m} value={m}>
                                {PAYMENT_MODES[m].label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Field>
            <p className="m-0 text-[13px] text-text-muted">{PAYMENT_MODES[settings.paymentMode].help}</p>
            <h4 className="m-0 mt-2 text-[13px] font-semibold text-text">Recent paid invoices</h4>
            {compared.length > 0 && (
                <p className="m-0 text-[13px] text-text-muted">
                    Of {compared.length} also entered by an Account Manager, the CRM chose the same deal for {agreed}.
                </p>
            )}
            {review.isError ? (
                <p className="m-0 text-[13px] text-text-muted">{failureText(review.error)}</p>
            ) : !review.data ? (
                <LoadingRegion label="Loading paid invoices" className="h-12" />
            ) : review.data.length === 0 ? (
                <p className="m-0 text-[13px] text-text-muted">NewswireOS has not reported a paid invoice yet.</p>
            ) : (
                <ul
                    aria-label="Recent paid invoices"
                    className="m-0 flex list-none flex-col divide-y divide-border p-0"
                >
                    {review.data.map((p) => (
                        <li key={p.id} className="flex flex-col gap-0.5 py-2 text-[13px]">
                            <span className="flex flex-wrap items-center gap-2">
                                <span className="min-w-0 flex-1 font-medium break-words">
                                    {p.invoiceNumber} · {p.clientName ?? p.clientEmail ?? 'A client'} ·{' '}
                                    {formatMoney(p.amount)}
                                </span>
                                {p.agrees !== null && (
                                    <Badge status={p.agrees ? 'success' : 'warning'}>
                                        {p.agrees ? 'Same deal' : 'Different deal'}
                                    </Badge>
                                )}
                                {p.mode === 'shadow' && <Badge status="neutral">Shadow</Badge>}
                            </span>
                            <span className="text-xs text-text-muted">
                                {DECISION_TEXT[p.decision]}{' '}
                                {p.opportunityId ? (
                                    <Link className="underline" to={paths.deal(workspaceId, p.opportunityId)}>
                                        {p.opportunityName ?? 'a deal'}
                                    </Link>
                                ) : p.mode === 'on' ? (
                                    <Link className="underline" to={paths.payment(workspaceId, p.id)}>
                                        choose a deal
                                    </Link>
                                ) : null}{' '}
                                · {formatWhen(p.occurredAt ?? p.createdAt)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
