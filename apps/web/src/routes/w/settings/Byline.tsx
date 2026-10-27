import { Badge, Button, Checkbox, Field, Input, LoadingRegion, toast } from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { useBylineSettings, usePutByline, useRemoveByline } from '../../../api/byline';
import { ApiError, fieldErrorAt } from '../../../api/client';
import { useMembers } from '../../../api/team';
import type { BylineSettingsView, MemberView } from '../../../api/types';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { CopyValue } from '../../../components/CopyValue';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { SETTINGS_SECTION_TITLE_ID } from './sectionTitle';

/** The shortest webhook secret the API accepts. */
const SECRET_MIN = 16;

const RESULT_TEXT: Record<string, string> = {
    ingested: 'A new lead came in.',
    duplicate: 'A lead already in the CRM came in again.',
    rejected: 'A delivery was not a lead the CRM could take.',
    bad_signature: 'A delivery was refused: it was not signed with this secret.',
};

/**
 * BylineAI (BYL-1): its leads come in through a signed webhook. A lead at a company a member owns is theirs; at any
 * other company it is dealt to the members picked here, in turn; with nobody picked it waits, unowned, in the Leads
 * queue.
 */
export function Byline() {
    const workspaceId = useWorkspaceId();
    const settings = useBylineSettings(workspaceId);
    const members = useMembers(workspaceId);
    if (settings.isError) throw settings.error;
    if (members.isError) throw members.error;
    return (
        <section aria-labelledby={SETTINGS_SECTION_TITLE_ID} className="max-w-3xl">
            <p className="m-0 mb-5 max-w-[70ch] text-[13px] text-text-muted">
                Leads BylineAI finds and a reviewer approves come in here. A lead at a company someone owns is theirs;
                at any other company it goes to the members picked below, in turn, who then own that company too. With
                nobody picked, it waits unowned for someone to claim it.
            </p>
            {settings.data && members.data ? (
                <BylineForm
                    key={JSON.stringify(settings.data)}
                    workspaceId={workspaceId}
                    settings={settings.data}
                    members={members.data}
                />
            ) : (
                <LoadingRegion label="Loading BylineAI settings" className="h-24" />
            )}
        </section>
    );
}

function BylineForm({
    workspaceId,
    settings,
    members,
}: {
    workspaceId: string;
    settings: BylineSettingsView;
    members: MemberView[];
}) {
    const put = usePutByline(workspaceId);
    const remove = useRemoveByline(workspaceId);
    const [secret, setSecret] = useState('');
    const [dealt, setDealt] = useState<string[]>(settings.roundRobinMemberIds);
    const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? '');
    const [apiKey, setApiKey] = useState('');
    const [verify, setVerify] = useState(settings.verifyWithByline);
    const [local, setLocal] = useState<{ secret?: string; baseUrl?: string; apiKey?: string }>({});
    const [confirm, setConfirm] = useState(false);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const errors: { secret?: string; baseUrl?: string; apiKey?: string } = {};
        const url = baseUrl.trim();
        if (secret !== '' && secret.length < SECRET_MIN)
            errors.secret = `At least ${SECRET_MIN} characters${settings.configured ? ', or leave it empty to keep it' : ''}.`;
        if (!settings.configured && !settings.apiConfigured && secret === '' && url === '')
            errors.secret = 'Enter the webhook secret, or BylineAI’s API below.';
        if (url !== '' && !/^https?:\/\/[^/\s]+/i.test(url)) errors.baseUrl = 'Enter BylineAI’s address.';
        if (url !== '' && !settings.apiConfigured && apiKey === '') errors.apiKey = 'Enter a BylineAI API key.';
        setLocal(errors);
        if (errors.secret || errors.baseUrl || errors.apiKey) return;
        put.mutate(
            {
                roundRobinMemberIds: dealt,
                ...(secret ? { secret } : {}),
                ...(url ? { baseUrl: url, verifyWithByline: verify } : settings.apiConfigured ? { baseUrl: null } : {}),
                ...(url && apiKey ? { apiKey } : {}),
            },
            {
                onSuccess: () => toast({ title: settings.configured ? 'BylineAI saved' : 'BylineAI linked' }),
                onError: (e) => {
                    if (!(e instanceof ApiError) || e.fieldErrors.length === 0) {
                        toast({ title: 'BylineAI was not saved', description: failureText(e), tone: 'danger' });
                    }
                },
            },
        );
    };

    return (
        <div className="flex flex-col gap-5">
            <form onSubmit={submit} noValidate className="flex flex-col gap-4">
                <Field
                    label="Webhook secret"
                    hint={
                        settings.configured
                            ? 'Set. Enter a new one only when you change BYLINE_WEBHOOK_SECRET in BylineAI too.'
                            : 'BylineAI signs every lead with it (BYLINE_WEBHOOK_SECRET); anything else is refused.'
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
                <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                    <legend className="mb-1 text-[13px] font-medium text-text">Deal new companies’ leads to</legend>
                    {members.map((m) => (
                        <label key={m.id} className="flex items-center gap-2 text-[13px]">
                            <Checkbox
                                checked={dealt.includes(m.id)}
                                onCheckedChange={(checked) =>
                                    setDealt((now) =>
                                        checked === true ? [...now, m.id] : now.filter((id) => id !== m.id),
                                    )
                                }
                            />
                            {m.displayName ?? m.email}
                        </label>
                    ))}
                    {fieldErrorAt(put.error, 'roundRobinMemberIds') && (
                        <p className="m-0 text-[13px] text-danger">{fieldErrorAt(put.error, 'roundRobinMemberIds')}</p>
                    )}
                </fieldset>
                <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
                    <legend className="mb-1 text-[13px] font-medium text-text">
                        Enrichment and verification from BylineAI
                    </legend>
                    <Field
                        label="BylineAI address"
                        hint="BylineAI’s site origin, https://byline.example — leave empty to stop asking BylineAI."
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
                        label="API key"
                        hint={
                            settings.apiConfigured
                                ? 'Set. Enter a new one only to replace it.'
                                : 'A BylineAI API key with the lookup role (BYLINE_API_KEYS="<key>:lookup"). Its paid layers run under BylineAI’s budgets.'
                        }
                        error={local.apiKey ?? fieldErrorAt(put.error, 'apiKey')}
                    >
                        <Input
                            type="password"
                            autoComplete="new-password"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            className="max-w-[28rem]"
                        />
                    </Field>
                    <label className="flex items-center gap-2 text-[13px]">
                        <Checkbox checked={verify} onCheckedChange={(checked) => setVerify(checked === true)} />
                        Verify addresses with BylineAI (its Reacher pool); the free checks answer when it cannot
                    </label>
                </fieldset>
                <div className="flex flex-wrap gap-2">
                    <Button type="submit" variant="primary" shape="square" loading={put.isPending}>
                        {settings.configured || settings.apiConfigured ? 'Save' : 'Link BylineAI'}
                    </Button>
                    {(settings.configured || settings.apiConfigured) && (
                        <Button type="button" variant="ghost" shape="square" onClick={() => setConfirm(true)}>
                            Unlink
                        </Button>
                    )}
                </div>
            </form>

            {settings.configured && (
                <section
                    aria-label="Webhook for BylineAI"
                    className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="m-0 text-[14px] font-semibold text-text">Leads</h3>
                        {settings.lastDeliveryResult === 'bad_signature' ? (
                            <Badge status="danger">Secret does not match</Badge>
                        ) : settings.lastDeliveryAt ? (
                            <Badge status="success">Receiving</Badge>
                        ) : (
                            <Badge status="neutral">Nothing received yet</Badge>
                        )}
                    </div>
                    <p className="m-0 flex flex-col gap-1 text-[13px]">
                        Set BylineAI’s BYLINE_WEBHOOK_URL to this, with the same secret:
                        <span className="flex flex-wrap items-center gap-2">
                            <code className="text-xs break-all">{settings.webhookUrl}</code>
                            <CopyValue value={settings.webhookUrl} label="Copy URL" />
                        </span>
                    </p>
                    <p className="m-0 text-[13px] text-text-muted">
                        {settings.lastDeliveryAt
                            ? `${RESULT_TEXT[settings.lastDeliveryResult ?? ''] ?? 'A delivery arrived.'} Last delivery ${formatWhen(settings.lastDeliveryAt)}.`
                            : 'A lead delivered twice is taken once.'}
                    </p>
                </section>
            )}

            <ConfirmDialog
                open={confirm}
                onOpenChange={setConfirm}
                title="Unlink BylineAI?"
                body="BylineAI’s deliveries are refused and it is no longer asked about addresses. Leads already in stay."
                confirm="Unlink"
                pending={remove.isPending}
                onConfirm={() =>
                    remove.mutate(undefined, {
                        onSuccess: () => {
                            setConfirm(false);
                            toast({ title: 'BylineAI unlinked' });
                        },
                        onError: (e) =>
                            toast({ title: 'That did not work', description: failureText(e), tone: 'danger' }),
                    })
                }
            />
        </div>
    );
}
