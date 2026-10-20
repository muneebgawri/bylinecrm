import type { ReputationSettings, ReputationSettingsView } from '@bylinecrm/shared';
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
    toast,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { fieldErrorAt } from '../../../api/client';
import { useUpdateReputationSettings } from '../../../api/reputation';
import { failureText } from '../../../lib/errors';

type NumberKey = Exclude<keyof ReputationSettings, 'primaryDomain'>;

/** Each threshold, with what it does (REP-1). Defaults: docs/design-notes/REP-1.md. */
const FIELDS: { key: NumberKey; label: string; hint: string }[] = [
    {
        key: 'dailyNewRecipients',
        label: 'New recipients per day',
        hint: 'Per personal mailbox, rolling 24 hours. Replies are never counted.',
    },
    { key: 'hourlyNewRecipients', label: 'New recipients per hour', hint: 'Spreads the day’s budget.' },
    { key: 'poolHourlyCap', label: 'Pool sends per hour', hint: 'Per pool mailbox, beside its daily cap.' },
    {
        key: 'nearDuplicateThreshold',
        label: 'Near-identical messages',
        hint: 'Distinct people in 24 hours before the next is refused.',
    },
    { key: 'nearDuplicateDistance', label: 'Near-identical within (bits)', hint: 'Of 64; lower is stricter.' },
    {
        key: 'subjectRepeatThreshold',
        label: 'Same subject',
        hint: 'Distinct new recipients in 24 hours before the next is refused.',
    },
    {
        key: 'replyRateFloorBps',
        label: 'Reply-rate floor (basis points)',
        hint: '100 = 1%. Under it, the mailbox is paused for new recipients.',
    },
    { key: 'replyRateMinSends', label: 'Judge reply rate after (sends)', hint: 'New-thread messages in the window.' },
    { key: 'replyRateWindowDays', label: 'Reply rate over (days)', hint: 'Counted from the last resume, if later.' },
    {
        key: 'spamPauseBps',
        label: 'Spam-rate kill switch (basis points)',
        hint: '30 = 0.3%, Google’s line. Pauses cold mail on the domain.',
    },
    { key: 'spamWarnBps', label: 'Spam-rate warning (basis points)', hint: 'Admins are warned at this rate.' },
];

/** Settings → Guardrails → Sender reputation (REP-1): the workspace's budgets and repetition thresholds. */
export function ReputationSettingsDialog({
    workspaceId,
    settings,
    onClose,
}: {
    workspaceId: string;
    settings: ReputationSettingsView;
    onClose: () => void;
}) {
    const update = useUpdateReputationSettings(workspaceId);
    const [values, setValues] = useState<Record<string, string>>(() => ({
        ...Object.fromEntries(FIELDS.map((f) => [f.key, String(settings[f.key])])),
        primaryDomain: settings.primaryDomain ?? '',
    }));
    const submit = (event: FormEvent) => {
        event.preventDefault();
        const input = {
            ...Object.fromEntries(FIELDS.map((f) => [f.key, Number(values[f.key])])),
            primaryDomain: values.primaryDomain?.trim() ? values.primaryDomain.trim() : null,
        } as ReputationSettings;
        update.mutate(input, {
            onSuccess: () => {
                toast({ title: 'Sender reputation saved', tone: 'success' });
                onClose();
            },
        });
    };
    const keys = [...FIELDS.map((f) => f.key), 'primaryDomain'];
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <form onSubmit={submit} noValidate>
                    <DialogTitle>Sender reputation</DialogTitle>
                    <DialogDescription>
                        Budgets and repetition limits for every mailbox. Mail sent in the CRM over a limit is refused;
                        mail sent straight from Gmail is flagged here instead.
                    </DialogDescription>
                    <DialogBody className="grid gap-3 sm:grid-cols-2">
                        {FIELDS.map((f) => (
                            <Field key={f.key} label={f.label} hint={f.hint} error={fieldErrorAt(update.error, f.key)}>
                                <Input
                                    type="number"
                                    inputMode="numeric"
                                    step="1"
                                    value={values[f.key] ?? ''}
                                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                                />
                            </Field>
                        ))}
                        <Field
                            label="Primary domain"
                            hint={`No sequence sends from a pool mailbox on it. Leave empty to use the members’ domain${
                                settings.effectivePrimaryDomain && !settings.primaryDomain
                                    ? ` (now ${settings.effectivePrimaryDomain})`
                                    : ''
                            }.`}
                            error={fieldErrorAt(update.error, 'primaryDomain')}
                        >
                            <Input
                                value={values.primaryDomain ?? ''}
                                placeholder="example.com"
                                onChange={(e) => setValues((v) => ({ ...v, primaryDomain: e.target.value }))}
                            />
                        </Field>
                    </DialogBody>
                    {update.error && !keys.some((k) => fieldErrorAt(update.error, k)) && (
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
