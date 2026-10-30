import { DEFAULT_UNSUBSCRIBE_FOOTER_TEXT, MAIL_SETTINGS_TEXT_MAX } from '@bylinecrm/shared';
import {
    Field,
    Input,
    LoadingRegion,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Skeleton,
    Textarea,
    toast,
} from '@bylinecrm/ui';
import { useMemo, useState, type FormEvent } from 'react';
import { ApiError, fieldErrorAt } from '../../../api/client';
import { useMailSettings, usePutMailSettings } from '../../../api/mailAdmin';
import type { MailSettingsView, PutMailSettingsInput } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { countries } from '../../../lib/countries';
import { failureText } from '../../../lib/errors';
import { SettingsSaveBar, SettingsSection } from './SettingsSection';
import { useWorkspaceId } from '../../params';
import { SETTINGS_SECTION_TITLE_ID } from './sectionTitle';

/**
 * What every outreach email carries in its locked footer (FR-CRMS-7, FR-CRMS-12): the workspace's
 * postal address and its unsubscribe wording, plus the name mail is sent under. Every member who
 * reads records may see them; only an admin may change them (the API is the gate — this page only
 * decides what to offer).
 */
interface FormState {
    line1: string;
    line2: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
    defaultSenderName: string;
    unsubscribeFooterText: string;
}

const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const;

function formFrom(settings: MailSettingsView): FormState {
    const address = settings.postalAddress;
    return {
        line1: address?.line1 ?? '',
        line2: address?.line2 ?? '',
        city: address?.city ?? '',
        region: address?.region ?? '',
        postalCode: address?.postalCode ?? '',
        country: address?.country ?? '',
        defaultSenderName: settings.defaultSenderName ?? '',
        unsubscribeFooterText: settings.unsubscribeFooterText,
    };
}

/** The address is all or nothing: blank fields mean "no address", which the API stores as null. */
export function toPutInput(form: FormState): PutMailSettingsInput {
    const anyAddress = ADDRESS_FIELDS.some((field) => form[field].trim() !== '');
    return {
        postalAddress: anyAddress
            ? {
                  line1: form.line1.trim(),
                  line2: form.line2.trim() || null,
                  city: form.city.trim(),
                  region: form.region.trim() || null,
                  postalCode: form.postalCode.trim(),
                  country: form.country,
              }
            : null,
        defaultSenderName: form.defaultSenderName.trim() || null,
        unsubscribeFooterText: form.unsubscribeFooterText.trim() || DEFAULT_UNSUBSCRIBE_FOOTER_TEXT,
    };
}

export function MailSettings() {
    const workspaceId = useWorkspaceId();
    const settings = useMailSettings(workspaceId);
    if (settings.isError) throw settings.error;
    return (
        <section aria-labelledby={SETTINGS_SECTION_TITLE_ID} className="max-w-2xl">
            <p className="m-0 mb-5 text-[13px] text-text-muted">
                Every outreach email ends with this address and an unsubscribe notice. They are required by law in most
                places mail is sent, and an outreach template cannot be sent until the address is set.
            </p>
            {settings.data ? (
                // A save (here or elsewhere) starts the form again from what is stored.
                <MailSettingsForm
                    key={JSON.stringify(settings.data)}
                    workspaceId={workspaceId}
                    settings={settings.data}
                />
            ) : (
                <LoadingRegion label="Loading mail settings" className="flex flex-col gap-4">
                    <Skeleton className="h-16" />
                    <Skeleton className="h-16" />
                    <Skeleton className="h-24" />
                </LoadingRegion>
            )}
        </section>
    );
}

function MailSettingsForm({ workspaceId, settings }: { workspaceId: string; settings: MailSettingsView }) {
    const edit = usePermission('workspace:admin');
    const put = usePutMailSettings(workspaceId);
    const [form, setForm] = useState<FormState>(() => formFrom(settings));
    const [local, setLocal] = useState<Partial<Record<keyof FormState, string>>>({});
    const saved = useMemo(() => formFrom(settings), [settings]);
    const dirty = (Object.keys(saved) as (keyof FormState)[]).some((key) => saved[key] !== form[key]);
    const countryList = useMemo(() => countries(), []);

    const set = (key: keyof FormState) => (value: string) => {
        setForm((current) => ({ ...current, [key]: value }));
        setLocal((current) => ({ ...current, [key]: undefined }));
    };
    const error = (key: keyof FormState) =>
        local[key] ?? fieldErrorAt(put.error, ADDRESS_FIELDS.includes(key as never) ? `postalAddress.${key}` : key);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const input = toPutInput(form);
        if (input.postalAddress) {
            const missing: Partial<Record<keyof FormState, string>> = {};
            if (!input.postalAddress.line1) missing.line1 = 'Enter the street address.';
            if (!input.postalAddress.city) missing.city = 'Enter the city.';
            if (!input.postalAddress.postalCode) missing.postalCode = 'Enter the postal code.';
            if (!input.postalAddress.country) missing.country = 'Choose the country.';
            if (Object.keys(missing).length) {
                setLocal(missing);
                return;
            }
        }
        put.mutate(input, {
            onSuccess: () => toast({ title: 'Mail settings saved' }),
            onError: (e) => {
                if (!(e instanceof ApiError) || e.fieldErrors.length === 0) {
                    toast({
                        title: 'Mail settings were not saved',
                        description: failureText(e),
                        tone: 'danger',
                    });
                }
            },
        });
    };

    const readOnly = !edit.allowed;
    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-6" aria-describedby="mail-settings-note">
            {readOnly && (
                <p
                    id="mail-settings-note"
                    className="m-0 rounded-md bg-surface-raised px-3 py-2 text-[13px] text-text-muted"
                >
                    {edit.reason} An admin changes these settings.
                </p>
            )}
            <SettingsSection
                title="Postal address"
                description="Printed at the foot of every outreach email, as the law requires."
                disabled={readOnly}
            >
                <Field label="Street address" error={error('line1')}>
                    <Input
                        value={form.line1}
                        onChange={(e) => set('line1')(e.target.value)}
                        autoComplete="address-line1"
                        maxLength={MAIL_SETTINGS_TEXT_MAX}
                    />
                </Field>
                <Field label="Address line 2" hint="Suite, floor, building — optional." error={error('line2')}>
                    <Input
                        value={form.line2}
                        onChange={(e) => set('line2')(e.target.value)}
                        autoComplete="address-line2"
                        maxLength={MAIL_SETTINGS_TEXT_MAX}
                    />
                </Field>
                <div className="grid gap-4 md:grid-cols-2">
                    <Field label="City" error={error('city')}>
                        <Input
                            value={form.city}
                            onChange={(e) => set('city')(e.target.value)}
                            autoComplete="address-level2"
                            maxLength={MAIL_SETTINGS_TEXT_MAX}
                        />
                    </Field>
                    <Field label="State, province or region" hint="Optional." error={error('region')}>
                        <Input
                            value={form.region}
                            onChange={(e) => set('region')(e.target.value)}
                            autoComplete="address-level1"
                            maxLength={MAIL_SETTINGS_TEXT_MAX}
                        />
                    </Field>
                    <Field label="Postal code" error={error('postalCode')}>
                        <Input
                            value={form.postalCode}
                            onChange={(e) => set('postalCode')(e.target.value)}
                            autoComplete="postal-code"
                            maxLength={MAIL_SETTINGS_TEXT_MAX}
                        />
                    </Field>
                    <Field label="Country" error={error('country')}>
                        <Select value={form.country} onValueChange={set('country')} disabled={readOnly}>
                            <SelectTrigger aria-label="Country">
                                <SelectValue placeholder="Choose a country" />
                            </SelectTrigger>
                            <SelectContent>
                                {countryList.map((country) => (
                                    <SelectItem key={country.code} value={country.code}>
                                        {country.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                </div>
            </SettingsSection>
            <SettingsSection title="Sending" description="How outreach mail introduces itself." disabled={readOnly}>
                <Field
                    label="Default sender name"
                    hint="Shown as who an email is from when a mailbox has no name of its own. Optional."
                    error={error('defaultSenderName')}
                >
                    <Input
                        value={form.defaultSenderName}
                        onChange={(e) => set('defaultSenderName')(e.target.value)}
                        maxLength={MAIL_SETTINGS_TEXT_MAX}
                    />
                </Field>
                <Field
                    label="Unsubscribe notice"
                    hint="The sentence above the Unsubscribe link in every outreach email."
                    error={error('unsubscribeFooterText')}
                >
                    <Textarea
                        rows={3}
                        value={form.unsubscribeFooterText}
                        onChange={(e) => set('unsubscribeFooterText')(e.target.value)}
                        maxLength={MAIL_SETTINGS_TEXT_MAX}
                    />
                </Field>
            </SettingsSection>
            {!readOnly && <SettingsSaveBar dirty={dirty} saving={put.isPending} saveLabel="Save" />}
        </form>
    );
}
