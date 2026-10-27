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
            <h3 className="m-0 mb-1 mt-6 text-sm font-semibold">Conflicts</h3>
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
 * The transfer cooling period (owner decision 2): days a record cannot go back to the member it left — not
 * offered to them, not accepted by them. Managers and admins are exempt. The server is the gate and the range.
 */
function CoolingSettings() {
    const workspaceId = useWorkspaceId();
    const settings = useOwnershipSettings(workspaceId);
    return settings.data ? <CoolingForm key={settings.data.transferCoolingDays} settings={settings.data} /> : null;
}

function CoolingForm({ settings }: { settings: OwnershipSettingsView }) {
    const workspaceId = useWorkspaceId();
    const put = usePutOwnershipSettings(workspaceId);
    const edit = usePermission('record:transfer');
    const [value, setValue] = useState(String(settings.transferCoolingDays));
    const [local, setLocal] = useState<string | undefined>();
    const parsed = Number(value);
    const dirty = parsed !== settings.transferCoolingDays;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (value.trim() === '' || !Number.isInteger(parsed)) {
            setLocal('Enter a whole number of days.');
            return;
        }
        put.mutate(
            { transferCoolingDays: parsed },
            {
                onSuccess: () => toast({ title: 'Transfer cooling period saved' }),
                onError: (e) => {
                    if (!(e instanceof ApiError) || e.fieldErrors.length === 0) {
                        toast({
                            title: 'The cooling period was not saved',
                            description: failureText(e),
                            tone: 'danger',
                        });
                    }
                },
            },
        );
    };

    return (
        <form onSubmit={submit} noValidate className="mb-2 flex items-end gap-3">
            <fieldset className="m-0 border-0 p-0" disabled={!edit.allowed}>
                <Field
                    label="Transfer cooling period (days)"
                    hint="After a transfer, the record cannot go back to the member it left for this many days. Managers and admins are exempt. 0 turns it off; the default is 14."
                    error={local ?? fieldErrorAt(put.error, 'transferCoolingDays')}
                >
                    <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={90}
                        step={1}
                        value={value}
                        onChange={(e) => {
                            setValue(e.target.value);
                            setLocal(undefined);
                        }}
                        className="max-w-[10rem]"
                    />
                </Field>
            </fieldset>
            {edit.allowed && (
                <Button type="submit" variant="primary" shape="square" loading={put.isPending} disabled={!dirty}>
                    Save
                </Button>
            )}
        </form>
    );
}
