import { DEFAULT_REGION_POLICY, REGION_LAWFUL_BASIS_MAX, type RegionCode } from '@bylinecrm/shared';
import { Badge, DataTableChrome, DropdownMenuItem, EmptyState, Field, Textarea, toast } from '@bylinecrm/ui';
import { useState } from 'react';
import { fieldErrorAt } from '../../../api/client';
import { useRegionPolicy, useRegionPolicyChanges, useSetRegionPolicy } from '../../../api/outreach';
import type { RegionPolicyEntryView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { useWorkspaceId } from '../../params';

/** A region as a row heading (capitalised; `REGION_LABELS` is phrased for a refusal's sentence). */
const REGION_NAME: Record<RegionCode, string> = {
    eu: 'EU',
    uk: 'UK',
    ca: 'Canada',
    us: 'US',
    other: 'Other countries',
    unknown: 'Unknown country',
};

/** What each region covers, as the enrolment check reads a person's country. */
const REGION_NOTE: Record<RegionCode, string> = {
    eu: 'The 27 EU member states.',
    uk: 'The United Kingdom.',
    ca: 'Canada.',
    us: 'The United States.',
    other: 'Every other country.',
    unknown:
        'No country on the person and none inferred from their address. Allowed, and each such person is flagged in the enrolment preview for review.',
};

/**
 * Where outreach may go (P3-UI-3, FR-CRMS-12, D-247): EU, UK and Canada are blocked until the
 * workspace opens one with its own lawful basis, stated; a contact with no known country is allowed
 * and flagged (D-251). Members with outreach rights read it; an admin changes it. Every change is
 * kept, with who made it and the basis given (#141).
 */
export function RegionPolicy() {
    const workspaceId = useWorkspaceId();
    const admin = useCan('workspace:admin');
    const policy = useRegionPolicy(workspaceId);
    const changes = useRegionPolicyChanges(workspaceId);
    const [changing, setChanging] = useState<RegionPolicyEntryView | null>(null);
    if (policy.isError) throw policy.error;
    if (changes.isError) throw changes.error;

    return (
        <section aria-labelledby="region-policy-title">
            <h2 id="region-policy-title" className="sr-only">
                Region policy
            </h2>
            <p className="m-0 mb-3 max-w-[65ch] text-[13px] text-text-muted">
                Sequences enrol a person only if outreach to their region is allowed. EU, UK and Canada are blocked
                until you state your own lawful basis for contacting them.
            </p>
            <DataTableChrome
                data={{
                    label: 'Region policy',
                    loading: policy.isPending,
                    rows: policy.data ?? [],
                    getRowId: (row) => row.region,
                    columns: [
                        {
                            id: 'region',
                            header: 'Region',
                            className: 'font-medium',
                            cell: (row) => (
                                <span className="flex flex-col">
                                    <span>{REGION_NAME[row.region]}</span>
                                    <span className="text-[12px] font-normal text-text-muted">
                                        {REGION_NOTE[row.region]}
                                    </span>
                                </span>
                            ),
                        },
                        {
                            id: 'state',
                            header: 'Outreach',
                            cell: (row) => (
                                <Badge status={row.allowed ? 'success' : 'danger'}>
                                    {row.allowed ? 'Allowed' : 'Blocked'}
                                </Badge>
                            ),
                        },
                        {
                            id: 'source',
                            header: 'Set by',
                            muted: true,
                            phone: 'meta',
                            cell: (row) => (row.isDefault ? 'Default' : 'Your workspace'),
                        },
                        {
                            id: 'basis',
                            header: 'Lawful basis',
                            muted: true,
                            phone: 'hidden',
                            cell: (row) => row.lawfulBasis ?? '—',
                        },
                    ],
                    rowActions: {
                        label: (row) => REGION_NAME[row.region],
                        items: (row) =>
                            admin ? (
                                <DropdownMenuItem destructive={row.allowed} onSelect={() => setChanging(row)}>
                                    {row.allowed ? 'Block outreach…' : 'Allow outreach…'}
                                </DropdownMenuItem>
                            ) : null,
                    },
                }}
            />
            <h3 className="mt-6 mb-2 text-[14px] font-semibold text-text">Changes</h3>
            <DataTableChrome
                data={{
                    label: 'Region policy changes',
                    loading: changes.isPending,
                    rows: changes.data ?? [],
                    getRowId: (change) => change.id,
                    empty: (
                        <EmptyState
                            className="m-4"
                            title="No changes yet"
                            body="Every region still follows the default."
                        />
                    ),
                    columns: [
                        {
                            id: 'when',
                            header: 'When',
                            muted: true,
                            phone: 'meta',
                            cell: (change) => formatDate(change.changedAt),
                        },
                        {
                            id: 'what',
                            header: 'Change',
                            className: 'font-medium',
                            cell: (change) =>
                                `${change.allowed ? 'Allowed' : 'Blocked'} outreach to ${REGION_NAME[change.region]}`,
                        },
                        {
                            id: 'who',
                            header: 'By',
                            muted: true,
                            cell: (change) => change.changedBy ?? 'A removed member',
                        },
                        {
                            id: 'basis',
                            header: 'Lawful basis',
                            muted: true,
                            phone: 'hidden',
                            cell: (change) => change.lawfulBasis ?? '—',
                        },
                    ],
                }}
            />
            <ChangeDialog workspaceId={workspaceId} entry={changing} onClose={() => setChanging(null)} />
        </section>
    );
}

function ChangeDialog({
    workspaceId,
    entry,
    onClose,
}: {
    workspaceId: string;
    entry: RegionPolicyEntryView | null;
    onClose: () => void;
}) {
    const set = useSetRegionPolicy(workspaceId);
    const [basis, setBasis] = useState('');
    const close = () => {
        setBasis('');
        set.reset();
        onClose();
    };
    const allowing = entry !== null && !entry.allowed;
    // Opening a region blocked by default needs the workspace's own lawful basis (D-247); the API checks the same.
    const needsBasis = allowing && entry !== null && !DEFAULT_REGION_POLICY[entry.region];
    const name = entry ? REGION_NAME[entry.region] : '';
    const verb = allowing ? 'Allow outreach' : 'Block outreach';
    return (
        <ConfirmDialog
            open={entry !== null}
            onOpenChange={(open) => !open && close()}
            title={`${verb} to ${name}?`}
            body={
                allowing
                    ? 'Sequences will enrol people in this region again. The change is recorded with your name.'
                    : 'Sequences stop enrolling people in this region; enrolments already running are not stopped. The change is recorded with your name.'
            }
            confirm={verb}
            pending={set.isPending}
            confirmDisabled={needsBasis && basis.trim() === ''}
            error={fieldErrorAt(set.error, 'lawfulBasis') ?? (set.isError ? failureText(set.error) : undefined)}
            onConfirm={() =>
                entry &&
                set.mutate(
                    allowing && needsBasis
                        ? { region: entry.region, allowed: true, lawfulBasis: basis.trim() }
                        : { region: entry.region, allowed: allowing },
                    {
                        onSuccess: () => {
                            toast({ title: `${allowing ? 'Allowed' : 'Blocked'} outreach to ${name}` });
                            close();
                        },
                    },
                )
            }
        >
            {needsBasis ? (
                <Field label="Lawful basis" required hint="For example a legitimate-interest assessment on file.">
                    <Textarea
                        value={basis}
                        maxLength={REGION_LAWFUL_BASIS_MAX}
                        onChange={(e) => setBasis(e.target.value)}
                        rows={3}
                    />
                </Field>
            ) : null}
        </ConfirmDialog>
    );
}
