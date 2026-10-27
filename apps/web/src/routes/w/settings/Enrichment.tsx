import {
    ENRICHMENT_LIMITS,
    ENRICHMENT_SOURCES,
    ENRICHMENT_SOURCE_LABELS,
    ENRICHMENT_SOURCE_NOTES,
    type EnrichmentSource,
} from '@bylinecrm/shared';
import { Button, Field, Input, LoadingRegion, Skeleton, Switch, toast } from '@bylinecrm/ui';
import { useId, useState, type FormEvent } from 'react';
import { ApiError, fieldErrorAt } from '../../../api/client';
import { useEnrichmentSettings, usePutEnrichmentSettings } from '../../../api/enrichment';
import type { EnrichmentSettingsView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { SETTINGS_SECTION_TITLE_ID } from './sectionTitle';

/**
 * Enrichment (P4-2, FR-CRMS-15): which free sources the workspace asks about its people and
 * companies, and how long an answer stands before the sources are asked again. Every member who
 * reads records may see them; an admin changes them.
 */
export function Enrichment() {
    const workspaceId = useWorkspaceId();
    const settings = useEnrichmentSettings(workspaceId);
    if (settings.isError) throw settings.error;
    return (
        <section aria-labelledby={SETTINGS_SECTION_TITLE_ID} className="max-w-2xl">
            <p className="m-0 mb-5 max-w-[70ch] text-[13px] text-text-muted">
                A new person or company, and one whose address or domain changes, is looked up in the sources below —
                free ones, and BylineAI when it is linked (its paid layers run under BylineAI’s budgets). Each answer is
                kept with where it came from and when it was asked, and written to the record only when it is better
                than what is there: an empty field takes any answer; what a member typed is never replaced.
            </p>
            {settings.data ? (
                // A save (here or elsewhere) starts the form again from what is stored.
                <SettingsForm key={JSON.stringify(settings.data)} workspaceId={workspaceId} settings={settings.data} />
            ) : (
                <LoadingRegion label="Loading enrichment settings" className="flex flex-col gap-3">
                    <Skeleton className="h-12" />
                    <Skeleton className="h-12" />
                    <Skeleton className="h-12" />
                </LoadingRegion>
            )}
        </section>
    );
}

function SettingsForm({ workspaceId, settings }: { workspaceId: string; settings: EnrichmentSettingsView }) {
    const edit = usePermission('workspace:admin');
    const put = usePutEnrichmentSettings(workspaceId);
    const [sources, setSources] = useState(settings.sources);
    const [age, setAge] = useState(String(settings.reaskAfterDays));
    const [local, setLocal] = useState<string | undefined>();
    const limits = ENRICHMENT_LIMITS.reaskAfterDays;
    const parsed = Number(age);
    const dirty =
        parsed !== settings.reaskAfterDays || ENRICHMENT_SOURCES.some((s) => sources[s] !== settings.sources[s]);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        // The range is the server's to refuse, with the field named; only a non-number is caught here.
        if (age.trim() === '' || !Number.isInteger(parsed)) {
            setLocal('Enter a whole number of days.');
            return;
        }
        put.mutate(
            { reaskAfterDays: parsed, sources },
            {
                onSuccess: () => toast({ title: 'Enrichment settings saved' }),
                onError: (e) => {
                    if (!(e instanceof ApiError) || e.fieldErrors.length === 0) {
                        toast({
                            title: 'Enrichment settings were not saved',
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
        <form onSubmit={submit} noValidate className="flex flex-col gap-5" aria-describedby="enrichment-note">
            {readOnly && (
                <p
                    id="enrichment-note"
                    className="m-0 rounded-md bg-surface-raised px-3 py-2 text-[13px] text-text-muted"
                >
                    {edit.reason} An admin changes these settings.
                </p>
            )}
            <fieldset className="m-0 flex flex-col gap-3 border-0 p-0" disabled={readOnly}>
                <legend className="mb-2 p-0 text-sm font-semibold">Sources</legend>
                {ENRICHMENT_SOURCES.map((source) => (
                    <SourceRow
                        key={source}
                        source={source}
                        on={sources[source]}
                        disabled={readOnly}
                        onChange={(on) => setSources((current) => ({ ...current, [source]: on }))}
                    />
                ))}
            </fieldset>
            <fieldset className="m-0 flex flex-col gap-3 border-0 p-0" disabled={readOnly}>
                <legend className="mb-2 p-0 text-sm font-semibold">Asking again</legend>
                <Field
                    label="Ask again after"
                    hint={`Days an answer stands before the sources are asked again. ${
                        settings.isDefault
                            ? 'The default is 90.'
                            : `Set by your workspace${settings.updatedAt ? ` on ${formatDate(settings.updatedAt)}` : ''}.`
                    }`}
                    error={local ?? fieldErrorAt(put.error, 'reaskAfterDays')}
                >
                    <Input
                        type="number"
                        inputMode="numeric"
                        min={limits.min}
                        max={limits.max}
                        step={1}
                        value={age}
                        onChange={(e) => {
                            setAge(e.target.value);
                            setLocal(undefined);
                        }}
                        className="max-w-[10rem]"
                    />
                </Field>
            </fieldset>
            {!readOnly && (
                <div>
                    <Button type="submit" variant="primary" shape="square" loading={put.isPending} disabled={!dirty}>
                        Save
                    </Button>
                </div>
            )}
        </form>
    );
}

function SourceRow({
    source,
    on,
    disabled,
    onChange,
}: {
    source: EnrichmentSource;
    on: boolean;
    disabled: boolean;
    onChange: (on: boolean) => void;
}) {
    const id = useId();
    const noteId = useId();
    return (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3">
            <Switch id={id} checked={on} disabled={disabled} onCheckedChange={onChange} aria-describedby={noteId} />
            <div className="flex min-w-0 flex-col gap-0.5">
                <label htmlFor={id} className="text-[13px] font-medium text-text">
                    {ENRICHMENT_SOURCE_LABELS[source]}
                </label>
                <p id={noteId} className="m-0 text-[13px] text-text-muted">
                    {ENRICHMENT_SOURCE_NOTES[source]}
                </p>
            </div>
        </div>
    );
}
