import { DORMANT_OWNER_MONTHS_LIMITS, TRANSFER_COOLING_DAYS_LIMITS } from '@bylinecrm/shared';
import { Button, DataTableChrome, EmptyState, Field, Input, toast } from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError, fieldErrorAt } from '../../../api/client';
import {
    useOwnershipConflicts,
    useOwnershipSettings,
    usePutOwnershipSettings,
    useResolveConflicts,
} from '../../../api/ownership';
import type { OwnershipConflictView, OwnershipSettingsView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { failureText } from '../../../lib/errors';
import { useWorkspaceId } from '../../params';
import { SettingsSaveBar, SettingsSection } from './SettingsSection';
import { paths } from '../../paths';
import { SETTINGS_SECTION_TITLE_ID } from './sectionTitle';

const KIND_LABEL: Record<OwnershipConflictView['kind'], string> = {
    domain_owned_by_other: 'Address at their company',
    duplicate_domain: 'Same company saved twice',
    company_owner_differs: 'Linked to their company',
};

/**
 * Ownership (OWN-2, #201): every record that disagrees with company ownership — a person or open deal held
 * by someone other than the company's owner — and the one fix, moving it to that owner. Each move is a
 * forced transfer, so both members are told. Managers only (`record:transfer`); the server is the gate.
 */
export function Ownership() {
    const workspaceId = useWorkspaceId();
    const conflicts = useOwnershipConflicts(workspaceId);
    const resolve = useResolveConflicts(workspaceId);
    const rows = conflicts.data ?? [];

    const run = (items: readonly OwnershipConflictView[]) =>
        resolve.mutate(
            // A duplicate company is merged by hand; only people and deals move.
            items.flatMap((c) => (c.object === 'company' ? [] : [{ object: c.object, recordId: c.recordId }])),
            {
                onSuccess: (r) =>
                    toast({
                        tone: 'success',
                        title: `${r.resolved.length} moved to their company’s owner`,
                        ...(r.skipped.length ? { description: `${r.skipped.length} were already resolved.` } : {}),
                    }),
                onError: (e) => toast({ tone: 'danger', title: 'Nothing was moved', description: failureText(e) }),
            },
        );

    return (
        <section aria-labelledby={SETTINGS_SECTION_TITLE_ID}>
            <CoolingSettings />
            <h3 className="m-0 mt-6 mb-2 text-base font-semibold">Conflicts</h3>
            <p className="m-0 mb-3 max-w-[65ch] text-[13px] text-text-muted">
                A company’s owner owns its people and deals. These records are held by someone else — usually from
                before the rule, an import, or a manager’s choice. Moving one hands it to the company’s owner, and both
                members are told.
            </p>
            <DataTableChrome
                toolbar={{
                    extra: (
                        <Button
                            data-primary-action
                            variant="primary"
                            shape="square"
                            size="sm"
                            disabled={rows.length === 0}
                            loading={resolve.isPending}
                            onClick={() => run(rows.filter((c) => c.object !== 'company'))}
                        >
                            Move all to their owners
                        </Button>
                    ),
                }}
                data={{
                    label: 'Ownership conflicts',
                    loading: conflicts.isPending,
                    rows,
                    getRowId: (c) => `${c.object}:${c.recordId}`,
                    empty: (
                        <EmptyState
                            className="m-4"
                            title="Nothing to resolve"
                            body="Every person and open deal is held by its company’s owner."
                        />
                    ),
                    columns: [
                        {
                            id: 'record',
                            header: 'Record',
                            className: 'font-medium',
                            cell: (c) => (
                                <Link
                                    to={
                                        c.object === 'person'
                                            ? paths.person(workspaceId, c.recordId)
                                            : c.object === 'company'
                                              ? paths.company(workspaceId, c.recordId)
                                              : paths.deal(workspaceId, c.recordId)
                                    }
                                >
                                    {c.recordLabel}
                                </Link>
                            ),
                        },
                        { id: 'kind', header: 'Why', cell: (c) => KIND_LABEL[c.kind] },
                        { id: 'holder', header: 'Held by', cell: (c) => c.recordOwnerName ?? 'Nobody' },
                        {
                            id: 'company',
                            header: 'Company',
                            cell: (c) => <Link to={paths.company(workspaceId, c.companyId)}>{c.companyName}</Link>,
                        },
                        { id: 'owner', header: 'Company owner', cell: (c) => c.companyOwnerName ?? 'A member' },
                        {
                            id: 'fix',
                            header: 'Fix',
                            cell: (c) =>
                                c.object === 'company' ? (
                                    <span className="text-xs text-text-muted">Merge or delete it by hand</span>
                                ) : (
                                    <Button
                                        size="sm"
                                        shape="square"
                                        disabled={resolve.isPending}
                                        onClick={() => run([c])}
                                    >
                                        Move to {c.companyOwnerName ?? 'owner'}
                                    </Button>
                                ),
                        },
                    ],
                }}
            />
        </section>
    );
}

/**
 * Settings → Ownership: the transfer cooling period (owner decision 2) — days a record cannot go back to the member
 * it left — and when a company's owner lets it go (OWN-2f) — months an owner may leave a company untouched and keep
 * it. Managers and admins edit; the server is the gate and the range.
 */
function CoolingSettings() {
    const workspaceId = useWorkspaceId();
    const settings = useOwnershipSettings(workspaceId);
    return settings.data ? (
        <CoolingForm
            key={`${settings.data.transferCoolingDays}-${settings.data.dormantOwnerMonths}`}
            settings={settings.data}
        />
    ) : null;
}

/** A whole number from a field, or null when it is not one. */
function wholeNumber(value: string): number | null {
    const n = Number(value);
    return value.trim() !== '' && Number.isInteger(n) ? n : null;
}

function CoolingForm({ settings }: { settings: OwnershipSettingsView }) {
    const workspaceId = useWorkspaceId();
    const put = usePutOwnershipSettings(workspaceId);
    const edit = usePermission('record:transfer');
    const [days, setDays] = useState(String(settings.transferCoolingDays));
    const [months, setMonths] = useState(String(settings.dormantOwnerMonths));
    const [local, setLocal] = useState<{ days?: string | undefined; months?: string | undefined }>({});
    const dirty =
        wholeNumber(days) !== settings.transferCoolingDays || wholeNumber(months) !== settings.dormantOwnerMonths;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const d = wholeNumber(days);
        const m = wholeNumber(months);
        if (d === null || m === null) {
            setLocal({
                ...(d === null ? { days: 'Enter a whole number of days.' } : {}),
                ...(m === null ? { months: 'Enter a whole number of months.' } : {}),
            });
            return;
        }
        put.mutate(
            { transferCoolingDays: d, dormantOwnerMonths: m },
            {
                onSuccess: () => toast({ title: 'Ownership settings saved' }),
                onError: (e) => {
                    if (!(e instanceof ApiError) || e.fieldErrors.length === 0) {
                        toast({
                            title: 'The ownership settings were not saved',
                            description: failureText(e),
                            tone: 'danger',
                        });
                    }
                },
            },
        );
    };

    return (
        <form onSubmit={submit} noValidate className="mb-2 flex flex-col gap-4">
            <SettingsSection
                title="Transfer cooling period"
                description="How long a transferred record stays away from the member it left."
                disabled={!edit.allowed}
            >
                <Field
                    label="Transfer cooling period (days)"
                    hint="After a transfer, the record cannot go back to the member it left for this many days. Managers and admins are exempt. 0 turns it off; the default is 14."
                    error={local.days ?? fieldErrorAt(put.error, 'transferCoolingDays')}
                >
                    <Input
                        type="number"
                        inputMode="numeric"
                        min={TRANSFER_COOLING_DAYS_LIMITS.min}
                        max={TRANSFER_COOLING_DAYS_LIMITS.max}
                        step={1}
                        value={days}
                        onChange={(e) => {
                            setDays(e.target.value);
                            setLocal((now) => ({ ...now, days: undefined }));
                        }}
                        className="max-w-[10rem]"
                    />
                </Field>
            </SettingsSection>
            <SettingsSection
                title="Inactive account owners"
                description="When a company stops being held by an owner who no longer works it."
                disabled={!edit.allowed}
            >
                <Field
                    label="Release an account after (months)"
                    hint="An owner with no open deal, no email, and nothing added or logged at a company for this many months no longer holds it: any member may email its contacts, and the next member to add a contact there becomes its owner. 0 turns it off; the default is 6."
                    error={local.months ?? fieldErrorAt(put.error, 'dormantOwnerMonths')}
                >
                    <Input
                        type="number"
                        inputMode="numeric"
                        min={DORMANT_OWNER_MONTHS_LIMITS.min}
                        max={DORMANT_OWNER_MONTHS_LIMITS.max}
                        step={1}
                        value={months}
                        onChange={(e) => {
                            setMonths(e.target.value);
                            setLocal((now) => ({ ...now, months: undefined }));
                        }}
                        className="max-w-[10rem]"
                    />
                </Field>
            </SettingsSection>
            {edit.allowed && <SettingsSaveBar dirty={dirty} saving={put.isPending} saveLabel="Save" />}
        </form>
    );
}
