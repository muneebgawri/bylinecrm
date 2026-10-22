import { GUARDRAIL_SHARED_MAILBOXES_MAX } from '@bylinecrm/shared';
import {
    Button,
    Checkbox,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Switch,
    toast,
} from '@bylinecrm/ui';
import { useId, useState, type FormEvent } from 'react';
import { fieldErrorAt } from '../../../api/client';
import { useMailboxCoverage, useUpdateGuardrailSettings } from '../../../api/guardrails';
import type { GuardrailSettingsView } from '../../../api/types';
import { failureText } from '../../../lib/errors';

/**
 * Settings → Guardrails → Poaching alerts (GUARD-2), admins only: whether a high alert is also emailed at once (off
 * by default; the bell and the daily digest always tell), and which members are shared mailboxes — leads they own
 * count as nobody's, so any member may mail them with no block and no alert. Ownership itself is not changed.
 */
export function GuardrailSettingsDialog({
    workspaceId,
    settings,
    onClose,
}: {
    workspaceId: string;
    settings: GuardrailSettingsView;
    onClose: () => void;
}) {
    const update = useUpdateGuardrailSettings(workspaceId);
    const members = useMailboxCoverage(workspaceId).data ?? [];
    const [emailAtOnce, setEmailAtOnce] = useState(settings.poachEmailAtOnce);
    const [shared, setShared] = useState<string[]>(settings.sharedMailboxMemberIds);
    const switchId = useId();
    const submit = (event: FormEvent) => {
        event.preventDefault();
        update.mutate(
            { poachEmailAtOnce: emailAtOnce, sharedMailboxMemberIds: shared },
            {
                onSuccess: () => {
                    toast({ title: 'Poaching alerts saved', tone: 'success' });
                    onClose();
                },
            },
        );
    };
    const sharedError = fieldErrorAt(update.error, 'sharedMailboxMemberIds');
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <form onSubmit={submit} noValidate>
                    <DialogTitle>Poaching alerts</DialogTitle>
                    <DialogDescription>
                        Mail a member sends to another member’s lead or a customer is flagged here, in the bell and in
                        the daily digest.
                    </DialogDescription>
                    <DialogBody className="flex flex-col gap-4">
                        <div className="flex items-center justify-between gap-3">
                            <label htmlFor={switchId} className="text-[13px]">
                                <span className="block font-medium text-text">Email high poaching alerts at once</span>
                                <span className="block text-text-muted">
                                    The lead’s owner and the managers get an email as soon as one is high. Off: the bell
                                    and the digest only.
                                </span>
                            </label>
                            <Switch id={switchId} checked={emailAtOnce} onCheckedChange={setEmailAtOnce} />
                        </div>
                        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                            <legend className="mb-1 text-[13px] font-medium text-text">Shared mailboxes</legend>
                            <p className="m-0 text-[13px] text-text-muted">
                                A mailbox many people send from, such as outreach@. Leads it owns are treated as
                                nobody’s: any member may email them or put them in a sequence, with no block and no
                                poaching alert. Who owns them does not change.
                            </p>
                            <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                                {members.map((m) => (
                                    <label key={m.memberId} className="flex items-center gap-2 text-[13px]">
                                        <Checkbox
                                            checked={shared.includes(m.memberId)}
                                            disabled={
                                                !shared.includes(m.memberId) &&
                                                shared.length >= GUARDRAIL_SHARED_MAILBOXES_MAX
                                            }
                                            onCheckedChange={(checked) =>
                                                setShared((now) =>
                                                    checked === true
                                                        ? [...now, m.memberId]
                                                        : now.filter((id) => id !== m.memberId),
                                                )
                                            }
                                        />
                                        <span className="font-medium">{m.name ?? m.email}</span>
                                        <span className="text-text-muted">{m.email}</span>
                                    </label>
                                ))}
                            </div>
                            {sharedError && <p className="m-0 text-[13px] text-danger">{sharedError}</p>}
                        </fieldset>
                    </DialogBody>
                    {update.error && !sharedError && (
                        <p role="alert" className="m-0 px-6 text-sm text-danger">
                            {failureText(update.error)}
                        </p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" disabled={update.isPending}>
                            Save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
