import {
    EMAIL_VERIFICATION_LIMITS,
    EMAIL_VERIFICATION_RESULT_LABELS,
    type EmailVerificationResult,
} from '@bylinecrm/shared';
import { Badge, Field, Input, LoadingRegion, toast } from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { ApiError, fieldErrorAt } from '../../../api/client';
import { usePutVerificationSettings, useVerificationSettings } from '../../../api/outreach';
import type { EmailVerificationSettingsView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { SettingsSaveBar, SettingsSection } from './SettingsSection';
import { SETTINGS_SECTION_TITLE_ID } from './sectionTitle';

/** What verification can find, and what the enrolment check does with each (doc 48 FR-CRMS-14). */
const RESULTS: readonly {
    result: EmailVerificationResult;
    tone: 'success' | 'danger' | 'warning' | 'neutral';
    means: string;
    enrolment: string;
}[] = [
    {
        result: 'valid',
        tone: 'success',
        means: 'The domain has a mail server, and the address is neither a role nor a throwaway.',
        enrolment: 'Enrolled.',
    },
    {
        result: 'invalid',
        tone: 'danger',
        means: 'Not an address, no such domain, no mail server, a domain that accepts no mail, or a throwaway (disposable) domain.',
        enrolment: 'Refused. A running enrolment whose address becomes invalid is stopped before its next email.',
    },
    {
        result: 'risky',
        tone: 'warning',
        means: 'Deliverable, but a role address (info@, press@…): it may not reach a person.',
        enrolment: 'Enrolled, and flagged in the preview for review.',
    },
    {
        result: 'unknown',
        tone: 'neutral',
        means: 'DNS did not answer, so nothing could be decided. Unknown is not valid.',
        enrolment: 'Not enrolled; checked again next time. A step waiting on it is tried again later.',
    },
];

/**
 * Email verification (P3-5, FR-CRMS-14, FR-CRMS-16): what the free layer checks before a person is
 * enrolled and again before every email step, what each result does, and how long a result stands
 * before it is found again. Members with outreach rights read it; an admin sets the age.
 */
export function Verification() {
    const workspaceId = useWorkspaceId();
    const settings = useVerificationSettings(workspaceId);
    if (settings.isError) throw settings.error;
    return (
        <section aria-labelledby={SETTINGS_SECTION_TITLE_ID} className="max-w-3xl">
            <p className="m-0 mb-5 max-w-[70ch] text-[13px] text-text-muted">
                Before a person is enrolled in a sequence, and again before each email step, their address is checked:
                its form, whether its domain has a mail server, and whether it is a throwaway mailbox or a role address.
                Nothing connects to the recipient’s mail server, and no mail is sent to find out.
            </p>
            <ul aria-label="Verification results" className="m-0 grid list-none gap-3 p-0 md:grid-cols-2">
                {RESULTS.map((row) => (
                    <li key={row.result} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
                        <div>
                            <Badge status={row.tone}>{EMAIL_VERIFICATION_RESULT_LABELS[row.result]}</Badge>
                        </div>
                        <p className="m-0 text-[13px] text-text">{row.means}</p>
                        <p className="m-0 text-[13px] text-text-muted">
                            <span className="font-medium text-text">At enrolment: </span>
                            {row.enrolment}
                        </p>
                    </li>
                ))}
            </ul>
            <h3 className="mt-6 mb-2 text-[14px] font-semibold text-text">Re-verification</h3>
            {settings.data ? (
                // A save (here or elsewhere) starts the form again from what is stored.
                <AgeForm key={JSON.stringify(settings.data)} workspaceId={workspaceId} settings={settings.data} />
            ) : (
                <LoadingRegion label="Loading verification settings" className="h-24" />
            )}
        </section>
    );
}

function AgeForm({ workspaceId, settings }: { workspaceId: string; settings: EmailVerificationSettingsView }) {
    const edit = usePermission('workspace:admin');
    const put = usePutVerificationSettings(workspaceId);
    const [value, setValue] = useState(String(settings.maxAgeDays));
    const [local, setLocal] = useState<string | undefined>();
    const limits = EMAIL_VERIFICATION_LIMITS.maxAgeDays;
    const parsed = Number(value);
    const dirty = parsed !== settings.maxAgeDays;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        // The range is the server's to refuse, with the field named; only a non-number is caught here.
        if (value.trim() === '' || !Number.isInteger(parsed)) {
            setLocal('Enter a whole number of days.');
            return;
        }
        put.mutate(
            { maxAgeDays: parsed },
            {
                onSuccess: () => toast({ title: 'Verification settings saved' }),
                onError: (e) => {
                    if (!(e instanceof ApiError) || e.fieldErrors.length === 0) {
                        toast({
                            title: 'Verification settings were not saved',
                            description: failureText(e),
                            tone: 'danger',
                        });
                    }
                },
            },
        );
    };

    const readOnly = !edit.allowed;
    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-describedby="verification-note">
            {readOnly && (
                <p
                    id="verification-note"
                    className="m-0 rounded-md bg-surface-raised px-3 py-2 text-[13px] text-text-muted"
                >
                    {edit.reason} An admin changes this setting.
                </p>
            )}
            <SettingsSection
                title="Re-verifying"
                description="How long a verification result stands."
                disabled={readOnly}
            >
                <Field
                    label="Re-verify after"
                    hint={`Days a result stands before it is found again before the next send. ${
                        settings.isDefault
                            ? 'The default is 90.'
                            : `Set by your workspace${settings.updatedAt ? ` on ${formatDate(settings.updatedAt)}` : ''}.`
                    }`}
                    error={local ?? fieldErrorAt(put.error, 'maxAgeDays')}
                >
                    <Input
                        type="number"
                        inputMode="numeric"
                        min={limits.min}
                        max={limits.max}
                        step={1}
                        value={value}
                        onChange={(e) => {
                            setValue(e.target.value);
                            setLocal(undefined);
                        }}
                        className="max-w-[10rem]"
                    />
                </Field>
            </SettingsSection>
            {!readOnly && <SettingsSaveBar dirty={dirty} saving={put.isPending} saveLabel="Save" />}
        </form>
    );
}
