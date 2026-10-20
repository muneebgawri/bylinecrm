import { Badge, Button, Field, Input, LoadingRegion, toast } from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { ApiError, fieldErrorAt } from '../../../api/client';
import {
    useNewswireosSettings,
    usePutNewswireos,
    useRemoveNewswireos,
    useRotateNewswireos,
} from '../../../api/invoices';
import type { NewswireosSettingsView } from '../../../api/types';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { CopyValue } from '../../../components/CopyValue';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';
import { useWorkspaceId } from '../../params';

/** The shortest hook secret the API accepts. */
const SECRET_MIN = 16;

const RESULT_TEXT: Record<string, string> = {
    applied: 'A refund or chargeback was applied to an invoice.',
    unmatched: 'A payment change arrived for no invoice in this workspace.',
    ignored: 'A delivery the CRM does not read was acknowledged.',
    ping: 'NewswireOS’s test ping arrived.',
    bad_signature: 'A delivery was refused: it was not signed with this secret.',
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
        <section aria-labelledby="newswireos-title" className="max-w-3xl">
            <h2 id="newswireos-title" className="m-0 mb-1 text-base font-semibold">
                NewswireOS
            </h2>
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
    const [local, setLocal] = useState<{ baseUrl?: string; apiToken?: string; secret?: string }>({});
    const [confirm, setConfirm] = useState<'rotate' | 'remove' | null>(null);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const errors: { baseUrl?: string; apiToken?: string; secret?: string } = {};
        if (!/^https?:\/\/[^/\s]+/i.test(baseUrl.trim())) errors.baseUrl = 'Enter NewswireOS’s address.';
        if (!settings.configured && !apiToken) errors.apiToken = 'Enter a NewswireOS API token.';
        if ((!settings.configured || secret !== '') && secret.length < SECRET_MIN)
            errors.secret = `At least ${SECRET_MIN} characters${settings.configured ? ', or leave it empty to keep it' : ''}.`;
        setLocal(errors);
        if (errors.baseUrl || errors.apiToken || errors.secret) return;
        put.mutate(
            { baseUrl: baseUrl.trim(), ...(apiToken ? { apiToken } : {}), ...(secret ? { secret } : {}) },
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
                            : 'A NewswireOS API token that may verify payments.'
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
                        settings.configured
                            ? 'Set. Enter a new one only when you change it in NewswireOS too.'
                            : 'NewswireOS signs refunds and chargebacks with it; anything else is refused.'
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
                        {settings.lastDeliveryResult === 'bad_signature' ? (
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
                            : 'A verified invoice that is refunded or charged back stops counting when NewswireOS says so.'}
                    </p>
                    <div>
                        <Button type="button" variant="secondary" shape="square" onClick={() => setConfirm('rotate')}>
                            New hook URL
                        </Button>
                    </div>
                </section>
            )}

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
