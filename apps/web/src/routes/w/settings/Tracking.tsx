import { Badge, Button, Field, Input, LoadingRegion, toast } from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { ApiError, fieldErrorAt } from '../../../api/client';
import {
    useCheckTrackingDomain,
    usePutTrackingDomain,
    useRemoveTrackingDomain,
    useTrackingSettings,
} from '../../../api/outreach';
import type { TrackingSettingsView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';
import { useWorkspaceId } from '../../params';

/**
 * Tracking (P3-4, FR-CRMS-8): the workspace's short-link domain, the CNAME to publish for it, and
 * whether it is verified — links in outreach mail are rewritten only once it is. Members with
 * outreach rights read it (the sequence pages' counts depend on it); an admin sets and checks it.
 */
export function Tracking() {
    const workspaceId = useWorkspaceId();
    const settings = useTrackingSettings(workspaceId);
    if (settings.isError) throw settings.error;
    return (
        <section aria-labelledby="tracking-title" className="max-w-3xl">
            <h2 id="tracking-title" className="m-0 mb-1 text-base font-semibold">
                Tracking
            </h2>
            <p className="m-0 mb-5 max-w-[70ch] text-[13px] text-text-muted">
                Links in outreach email are shortened through a domain of yours, so a click is recorded on the person’s
                timeline and may move a deal by a stage rule. An open is only ever indicative: mail clients and security
                scanners fetch images without anyone reading, so it is shown but never moves anything. Until the domain
                is set and verified, links go out as written. Personal 1:1 mail and unsubscribe links are never
                rewritten.
            </p>
            {settings.data ? (
                // A save (here or elsewhere) starts the form again from what is stored.
                <DomainForm key={JSON.stringify(settings.data)} workspaceId={workspaceId} settings={settings.data} />
            ) : (
                <LoadingRegion label="Loading tracking settings" className="h-24" />
            )}
        </section>
    );
}

function DomainForm({ workspaceId, settings }: { workspaceId: string; settings: TrackingSettingsView }) {
    const edit = usePermission('workspace:admin');
    const put = usePutTrackingDomain(workspaceId);
    const check = useCheckTrackingDomain(workspaceId);
    const remove = useRemoveTrackingDomain(workspaceId);
    const current = settings.domain;
    const [value, setValue] = useState(current?.domain ?? '');
    const [local, setLocal] = useState<string | undefined>();
    const [removing, setRemoving] = useState(false);
    const dirty = value.trim().toLowerCase() !== (current?.domain ?? '');
    const readOnly = !edit.allowed;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const domain = value.trim().toLowerCase();
        if (domain === '') {
            setLocal('Enter the domain, such as go.example.com.');
            return;
        }
        put.mutate(
            { domain },
            {
                onSuccess: () =>
                    toast({ title: 'Short-link domain saved', description: 'Publish the DNS record, then check it.' }),
                onError: (e) => {
                    if (!(e instanceof ApiError) || e.fieldErrors.length === 0) {
                        toast({ title: 'The domain was not saved', description: failureText(e), tone: 'danger' });
                    }
                },
            },
        );
    };

    return (
        <div className="flex flex-col gap-5">
            {readOnly && (
                <p
                    id="tracking-note"
                    className="m-0 rounded-md bg-surface-raised px-3 py-2 text-[13px] text-text-muted"
                >
                    {edit.reason} An admin changes the short-link domain.
                </p>
            )}
            {!readOnly && (
                <form onSubmit={submit} noValidate className="flex flex-col gap-4">
                    <Field
                        label="Short-link domain"
                        hint="A hostname you own, used only for tracked links: go.example.com."
                        error={local ?? fieldErrorAt(put.error, 'domain')}
                    >
                        <Input
                            type="text"
                            inputMode="url"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="go.example.com"
                            value={value}
                            onChange={(e) => {
                                setValue(e.target.value);
                                setLocal(undefined);
                            }}
                            className="max-w-[24rem]"
                        />
                    </Field>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="submit"
                            variant="primary"
                            shape="square"
                            loading={put.isPending}
                            disabled={!dirty}
                        >
                            Save
                        </Button>
                        {current && (
                            <Button type="button" variant="ghost" shape="square" onClick={() => setRemoving(true)}>
                                Remove domain
                            </Button>
                        )}
                    </div>
                </form>
            )}
            {current ? (
                <section
                    aria-label="DNS record to publish"
                    className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="m-0 text-[14px] font-semibold text-text">DNS record to publish</h3>
                        {current.status === 'pass' ? (
                            <Badge status="success">Verified</Badge>
                        ) : (
                            <Badge status={current.status === 'fail' ? 'danger' : 'neutral'}>Not verified</Badge>
                        )}
                    </div>
                    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
                        <dt className="text-text-muted">Name</dt>
                        <dd className="m-0 break-all font-mono">{current.domain}</dd>
                        <dt className="text-text-muted">Type</dt>
                        <dd className="m-0 font-mono">CNAME</dd>
                        <dt className="text-text-muted">Target</dt>
                        <dd className="m-0 break-all font-mono">{settings.cnameTarget}</dd>
                    </dl>
                    <p className="m-0 text-[13px] text-text-muted">
                        {current.lastCheck
                            ? `${current.lastCheck.message}${current.checkedAt ? ` — checked ${formatWhen(current.checkedAt)}.` : ''}`
                            : 'Not checked yet. Publish the record at your DNS provider, then check it here.'}
                    </p>
                    {!readOnly && (
                        <div>
                            <Button
                                type="button"
                                variant="secondary"
                                shape="square"
                                loading={check.isPending}
                                onClick={() =>
                                    check.mutate(undefined, {
                                        onError: (e) =>
                                            toast({
                                                title: 'The domain could not be checked',
                                                description: failureText(e),
                                                tone: 'danger',
                                            }),
                                    })
                                }
                            >
                                Check now
                            </Button>
                        </div>
                    )}
                </section>
            ) : (
                <p className="m-0 text-[13px] text-text-muted">
                    No short-link domain yet: links in outreach email go out untracked until one is set and verified.
                </p>
            )}
            <p className="m-0 text-[13px] text-text-muted">
                Opens are indicative. Clicks and opens from known link scanners, and any within two seconds of delivery,
                are kept out of every count.
            </p>
            <ConfirmDialog
                open={removing}
                onOpenChange={setRemoving}
                title="Remove the short-link domain?"
                body="New outreach email goes out untracked. Links already sent keep working."
                confirm="Remove"
                pending={remove.isPending}
                onConfirm={() =>
                    remove.mutate(undefined, {
                        onSuccess: () => {
                            setRemoving(false);
                            toast({ title: 'Short-link domain removed' });
                        },
                        onError: (e) =>
                            toast({ title: 'The domain was not removed', description: failureText(e), tone: 'danger' }),
                    })
                }
            />
        </div>
    );
}
