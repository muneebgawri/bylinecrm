import { Badge, Button, Field, Input, LoadingRegion, toast } from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { usePutQuo, useQuoSettings, useRematchQuo, useRemoveQuo } from '../../../api/calls';
import { ApiError, fieldErrorAt } from '../../../api/client';
import { useMembers } from '../../../api/team';
import type { MemberView, QuoSettingsView } from '../../../api/types';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { CopyValue } from '../../../components/CopyValue';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { SettingsSaveBar, SettingsSection } from './SettingsSection';
import { SETTINGS_SECTION_TITLE_ID } from './sectionTitle';

const RESULT_TEXT: Record<string, string> = {
    recorded: 'A call came in.',
    updated: 'A call was brought up to date (a recording, a summary, a transcript).',
    ignored: 'A delivery that was not about a call was acknowledged and ignored.',
    unknown_call: 'Quo named a call it then could not give back.',
    bad_signature: 'A delivery was refused: it was not signed with this webhook’s key.',
};

/**
 * Quo (CALL-1): calls placed and taken in the Quo app come in here. Saving an API key registers the CRM as a
 * webhook at Quo and matches Quo's users to members by email; a member unmatched has their calls logged as
 * nobody's until they join Quo under the same address.
 */
export function Quo() {
    const workspaceId = useWorkspaceId();
    const settings = useQuoSettings(workspaceId);
    const members = useMembers(workspaceId);
    if (settings.isError) throw settings.error;
    if (members.isError) throw members.error;
    return (
        <section aria-labelledby={SETTINGS_SECTION_TITLE_ID} className="max-w-3xl">
            <p className="m-0 mb-5 max-w-[70ch] text-[13px] text-text-muted">
                Reps call from the Quo app; the CRM keeps the log. Every call to or from a person’s number lands on
                their timeline with its outcome, and Quo’s recording, summary and transcript follow once Quo has them.
                “Call” on a person opens the number in Quo and the call-notes panel.
            </p>
            {settings.data && members.data ? (
                <QuoForm
                    key={settings.data.lastDeliveryAt ?? 'none'}
                    workspaceId={workspaceId}
                    settings={settings.data}
                    members={members.data}
                />
            ) : (
                <LoadingRegion label="Loading Quo settings" className="h-24" />
            )}
        </section>
    );
}

function QuoForm({
    workspaceId,
    settings,
    members,
}: {
    workspaceId: string;
    settings: QuoSettingsView;
    members: MemberView[];
}) {
    const put = usePutQuo(workspaceId);
    const rematch = useRematchQuo(workspaceId);
    const remove = useRemoveQuo(workspaceId);
    const [apiKey, setApiKey] = useState('');
    const [confirm, setConfirm] = useState(false);
    const dirty = apiKey.trim() !== '';
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!dirty) return;
        put.mutate(apiKey.trim(), {
            onSuccess: () => {
                setApiKey('');
                toast({ title: settings.configured ? 'Quo key saved' : 'Quo linked' });
            },
            onError: (e) => {
                if (!(e instanceof ApiError) || e.fieldErrors.length === 0) {
                    toast({ title: 'Quo was not linked', description: failureText(e), tone: 'danger' });
                }
            },
        });
    };
    const matched = new Set(settings.matchedMemberIds);
    const active = members;
    return (
        <div className="flex flex-col gap-5">
            <form onSubmit={submit} noValidate className="flex flex-col gap-5">
                <SettingsSection
                    title="API key"
                    description="From Quo: Settings → API. Saving it registers the CRM’s receiver at Quo; there is nothing to paste there."
                >
                    <Field
                        label="Quo API key"
                        hint={
                            settings.configured
                                ? 'Set. Enter a new one only to replace it.'
                                : 'Needed once; never shown back.'
                        }
                        error={fieldErrorAt(put.error, 'apiKey')}
                    >
                        <Input
                            type="password"
                            autoComplete="new-password"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            className="max-w-[28rem]"
                        />
                    </Field>
                    <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
                        <span>Webhook</span>
                        {settings.webhookRegistered ? (
                            <Badge status="success">Registered at Quo</Badge>
                        ) : (
                            <Badge>Not registered</Badge>
                        )}
                        <CopyValue value={settings.webhookUrl} label="Copy receiver URL" />
                    </div>
                    {settings.lastDeliveryAt && (
                        <p className="m-0 text-[13px] text-text-muted">
                            Last delivery {formatWhen(settings.lastDeliveryAt)}
                            {settings.lastDeliveryResult
                                ? ` — ${RESULT_TEXT[settings.lastDeliveryResult] ?? settings.lastDeliveryResult}`
                                : ''}
                        </p>
                    )}
                </SettingsSection>
                <SettingsSaveBar
                    dirty={dirty}
                    saving={put.isPending}
                    onReset={() => setApiKey('')}
                    saveLabel={settings.configured ? 'Save key' : 'Link Quo'}
                    extra={
                        settings.configured ? (
                            <Button type="button" variant="ghost" onClick={() => setConfirm(true)}>
                                Unlink
                            </Button>
                        ) : undefined
                    }
                />
            </form>
            {settings.configured && (
                <SettingsSection
                    title="Members in Quo"
                    description="Matched by email. A member not in Quo has their calls logged as nobody’s until they join under the same address."
                >
                    <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
                        {active.map((m) => (
                            <li key={m.id} className="flex items-center gap-2">
                                {matched.has(m.id) ? <Badge status="success">In Quo</Badge> : <Badge>Not in Quo</Badge>}
                                <span className="font-medium">{m.displayName ?? m.email}</span>
                                <span className="text-text-muted">{m.email}</span>
                            </li>
                        ))}
                    </ul>
                    {settings.unmatchedQuoEmails.length > 0 && (
                        <p className="m-0 text-[13px] text-text-muted">
                            In Quo but not members here: {settings.unmatchedQuoEmails.join(', ')}
                        </p>
                    )}
                    <div>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            loading={rematch.isPending}
                            onClick={() =>
                                rematch.mutate(undefined, {
                                    onSuccess: () => toast({ title: 'Members matched again' }),
                                    onError: (e) =>
                                        toast({
                                            title: 'Could not ask Quo',
                                            description: failureText(e),
                                            tone: 'danger',
                                        }),
                                })
                            }
                        >
                            Match again
                        </Button>
                    </div>
                </SettingsSection>
            )}
            <ConfirmDialog
                open={confirm}
                onOpenChange={setConfirm}
                title="Unlink Quo?"
                body="The webhook is removed at Quo and the key forgotten. Calls already in stay."
                confirm="Unlink"
                pending={remove.isPending}
                onConfirm={() =>
                    remove.mutate(undefined, {
                        onSuccess: () => {
                            setConfirm(false);
                            toast({ title: 'Quo unlinked' });
                        },
                        onError: (e) =>
                            toast({ title: 'Quo was not unlinked', description: failureText(e), tone: 'danger' }),
                    })
                }
            />
        </div>
    );
}
