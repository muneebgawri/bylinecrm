import { Badge, Button, Field, Input, LoadingRegion, toast } from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { ApiError, fieldErrorAt } from '../../../api/client';
import { usePutSlotline, useRemoveSlotline, useRotateSlotline, useSlotlineSettings } from '../../../api/meetings';
import type { SlotlineSettingsView } from '../../../api/types';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { CopyValue } from '../../../components/CopyValue';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { SETTINGS_SECTION_TITLE_ID } from './sectionTitle';

/** Slotline's page for a webhook that fires for every booking on the site (an instance admin's). */
const SLOTLINE_PLATFORM_WEBHOOK_PATH = '/settings/developer/webhooks/new?platform=true';

/** The shortest secret the API accepts: it is all that stands between the public hook and a forged booking. */
const SECRET_MIN = 16;

/** What the last delivery's result means, in words. */
const RESULT_TEXT: Record<string, string> = {
    stored: 'A booking was stored.',
    cancelled: 'A cancellation was applied.',
    ignored: 'A delivery the CRM does not read was acknowledged.',
    unmatched: 'A booking was left: no member organised it.',
    ping: 'Slotline’s test ping arrived.',
    bad_signature: 'A delivery was refused: it was not signed with this secret.',
};

/**
 * Slotline (CAL-2): the workspace's booking site. Its bookings reach the CRM as a signed webhook and count as
 * the organising member's meetings — their KPIs, and the people who booked as their leads — the same meeting
 * as the Google Calendar event Slotline writes for it. An admin sets the site's address and the webhook's
 * secret here, and copies the hook URL into Slotline.
 */
export function Slotline() {
    const workspaceId = useWorkspaceId();
    const settings = useSlotlineSettings(workspaceId);
    if (settings.isError) throw settings.error;
    return (
        <section aria-labelledby={SETTINGS_SECTION_TITLE_ID} className="max-w-3xl">
            <p className="m-0 mb-5 max-w-[70ch] text-[13px] text-text-muted">
                Bookings made on your Slotline booking site count as the organising member’s meetings: they show on the
                Team page, the people who booked become that member’s leads, and the meeting is on their records’
                timelines. A booking that also lands in the member’s Google Calendar is counted once.
            </p>
            {settings.data ? (
                <SlotlineForm key={JSON.stringify(settings.data)} workspaceId={workspaceId} settings={settings.data} />
            ) : (
                <LoadingRegion label="Loading Slotline settings" className="h-24" />
            )}
        </section>
    );
}

function SlotlineForm({ workspaceId, settings }: { workspaceId: string; settings: SlotlineSettingsView }) {
    const put = usePutSlotline(workspaceId);
    const rotate = useRotateSlotline(workspaceId);
    const remove = useRemoveSlotline(workspaceId);
    const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? 'https://');
    const [secret, setSecret] = useState('');
    const [local, setLocal] = useState<{ baseUrl?: string | undefined; secret?: string | undefined }>({});
    const [confirm, setConfirm] = useState<'rotate' | 'remove' | null>(null);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const errors: { baseUrl?: string | undefined; secret?: string | undefined } = {};
        if (!/^https:\/\/[^/\s]+/i.test(baseUrl.trim())) errors.baseUrl = 'Enter the booking site’s https address.';
        if (!settings.configured && secret.length < SECRET_MIN)
            errors.secret = `Enter the webhook’s secret: at least ${SECRET_MIN} characters.`;
        if (settings.configured && secret !== '' && secret.length < SECRET_MIN)
            errors.secret = `At least ${SECRET_MIN} characters, or leave it empty to keep the current one.`;
        setLocal(errors);
        if (errors.baseUrl || errors.secret) return;
        put.mutate(
            { baseUrl: baseUrl.trim(), ...(secret ? { secret } : {}) },
            {
                onSuccess: () =>
                    toast({
                        title: settings.configured ? 'Slotline saved' : 'Slotline connected',
                        description: 'Use the hook URL below on the webhook in Slotline.',
                    }),
                onError: (e) => {
                    if (!(e instanceof ApiError) || e.fieldErrors.length === 0) {
                        toast({ title: 'Slotline was not saved', description: failureText(e), tone: 'danger' });
                    }
                },
            },
        );
    };

    return (
        <div className="flex flex-col gap-5">
            <form onSubmit={submit} noValidate className="flex flex-col gap-4">
                <Field
                    label="Booking site"
                    hint="Where people book: https://bookings.example.com."
                    error={local.baseUrl ?? fieldErrorAt(put.error, 'baseUrl')}
                >
                    <Input
                        type="url"
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        value={baseUrl}
                        onChange={(e) => {
                            setBaseUrl(e.target.value);
                            setLocal((l) => ({ ...l, baseUrl: undefined }));
                        }}
                        className="max-w-[28rem]"
                    />
                </Field>
                <Field
                    label="Webhook secret"
                    hint={
                        settings.configured
                            ? 'Set. Enter a new one only when you change it in Slotline too.'
                            : 'The secret you enter on the webhook in Slotline. Deliveries not signed with it are refused.'
                    }
                    error={local.secret ?? fieldErrorAt(put.error, 'secret')}
                >
                    <Input
                        type="password"
                        autoComplete="new-password"
                        value={secret}
                        onChange={(e) => {
                            setSecret(e.target.value);
                            setLocal((l) => ({ ...l, secret: undefined }));
                        }}
                        className="max-w-[28rem]"
                    />
                </Field>
                <div className="flex flex-wrap gap-2">
                    <Button type="submit" variant="primary" shape="square" loading={put.isPending}>
                        {settings.configured ? 'Save' : 'Connect Slotline'}
                    </Button>
                    {settings.configured && (
                        <Button type="button" variant="ghost" shape="square" onClick={() => setConfirm('remove')}>
                            Disconnect
                        </Button>
                    )}
                </div>
            </form>

            {settings.configured && settings.hookUrl && (
                <section
                    aria-label="Webhook to add in Slotline"
                    className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="m-0 text-[14px] font-semibold text-text">Webhook to add in Slotline</h3>
                        {settings.lastDeliveryResult === 'bad_signature' ? (
                            <Badge status="danger">Secret does not match</Badge>
                        ) : settings.lastDeliveryAt ? (
                            <Badge status="success">Receiving</Badge>
                        ) : (
                            <Badge status="neutral">Nothing received yet</Badge>
                        )}
                    </div>
                    <ol className="m-0 flex flex-col gap-2 pl-5 text-[13px]">
                        <li>
                            Signed in to Slotline as its instance admin, open{' '}
                            <a
                                className="text-accent underline break-all"
                                href={`${settings.baseUrl}${SLOTLINE_PLATFORM_WEBHOOK_PATH}`}
                                target="_blank"
                                rel="noreferrer"
                            >
                                {`${settings.baseUrl}${SLOTLINE_PLATFORM_WEBHOOK_PATH}`}
                            </a>{' '}
                            — one webhook for every booking on the site. (Or each member adds one under Settings →
                            Developer → Webhooks.)
                        </li>
                        <li className="flex flex-col gap-1">
                            Subscriber URL:
                            <span className="flex flex-wrap items-center gap-2">
                                <code className="text-xs break-all">{settings.hookUrl}</code>
                                <CopyValue value={settings.hookUrl} label="Copy URL" />
                            </span>
                        </li>
                        <li>Secret: the same one as above.</li>
                        <li>Leave the custom payload template empty: the CRM reads Slotline’s own format.</li>
                        <li>
                            Events: <span className="font-mono text-xs">{settings.triggers.join(', ')}</span>.
                        </li>
                    </ol>
                    <p className="m-0 text-[13px] text-text-muted">
                        {settings.lastDeliveryAt
                            ? `${RESULT_TEXT[settings.lastDeliveryResult ?? ''] ?? 'A delivery arrived.'} Last delivery ${formatWhen(settings.lastDeliveryAt)}.`
                            : 'Use Slotline’s “Ping test” to check the connection.'}
                    </p>
                    {settings.unmatchedOrganizers > 0 && (
                        <p className="m-0 text-[13px] text-warning">
                            {settings.unmatchedOrganizers} booking
                            {settings.unmatchedOrganizers === 1 ? ' was' : 's were'} left because no member organised{' '}
                            {settings.unmatchedOrganizers === 1 ? 'it' : 'them'} — last by{' '}
                            {settings.lastUnmatchedOrganizer}. A member is found by their sign-in address or a connected
                            personal mailbox’s.
                        </p>
                    )}
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
                title={confirm === 'rotate' ? 'Make a new hook URL?' : 'Disconnect Slotline?'}
                body={
                    confirm === 'rotate'
                        ? 'The current URL stops working at once; update the webhook in Slotline with the new one.'
                        : 'New bookings stop reaching the CRM. Meetings and leads already stored stay.'
                }
                confirm={confirm === 'rotate' ? 'Make a new URL' : 'Disconnect'}
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
                    else remove.mutate(undefined, { onSuccess: done('Slotline disconnected'), onError: failed });
                }}
            />
        </div>
    );
}
