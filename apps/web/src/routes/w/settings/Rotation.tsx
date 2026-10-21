import { MAILBOX_PREFERENCES, type MailboxPreference, type RotationMemberView } from '@bylinecrm/shared';
import { Badge, Button, DataTableChrome, DropdownMenuItem, Input, toast } from '@bylinecrm/ui';
import { useState } from 'react';
import { usePipelines } from '../../../api/deals';
import {
    useRotationMembers,
    useRotationPreview,
    useRotationSettings,
    useSetRotationMember,
    useSetRotationSettings,
    type RotationSettingsInput,
} from '../../../api/rotation';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { CadenceSection } from './CadenceSection';
import { SelectField, SwitchRow } from './fields';

const MAILBOX_TEXT: Readonly<Record<MailboxPreference, string>> = {
    prefer: 'Prefer reps with a connected mailbox',
    require: 'Only reps with a connected mailbox',
    ignore: 'Ignore mailboxes',
};
const ACTION_TEXT = { warn: 'Warn now', rotate: 'Rotate now', waiting: 'Waiting' } as const;
const ACTION_TONE = { warn: 'warning', rotate: 'danger', waiting: 'neutral' } as const;
const DAY = 24 * 60 * 60 * 1000;

const onError = (e: unknown) => toast({ title: failureText(e), tone: 'danger' });

/**
 * Settings → Rotation (CADENCE-1): every open lead is due a touch by its stage's cadence; a missed cadence warns the
 * owner, and the grace later the lead rotates to the next rep in turn. Here a manager or an admin switches it on,
 * sets the warning and the grace, pauses reps (until a date), edits each stage's cadence, and previews — before and
 * after switching on — what the hourly job would do. Nothing in the preview is written.
 */
export function Rotation() {
    const workspaceId = useWorkspaceId();
    const settings = useRotationSettings(workspaceId);
    const save = useSetRotationSettings(workspaceId);
    const members = useRotationMembers(workspaceId);
    const setMember = useSetRotationMember(workspaceId);
    const pipelines = usePipelines(workspaceId);
    const [previewing, setPreviewing] = useState(false);
    const preview = useRotationPreview(workspaceId, previewing);
    if (settings.isError) throw settings.error;
    if (members.isError) throw members.error;

    const current: RotationSettingsInput | null = settings.data
        ? {
              enabled: settings.data.enabled,
              warnAfterDays: settings.data.warnAfterDays,
              graceDays: settings.data.graceDays,
              intakeEnabled: settings.data.intakeEnabled,
              mailboxPreference: settings.data.mailboxPreference,
              openLeadCap: settings.data.openLeadCap,
          }
        : null;
    const change = (patch: Partial<RotationSettingsInput>) => {
        if (current) save.mutate({ ...current, ...patch }, { onError });
    };
    const member = (row: RotationMemberView, patch: Parameters<typeof setMember.mutate>[0]['patch']) =>
        setMember.mutate({ memberId: row.memberId, patch }, { onError });

    return (
        <section aria-labelledby="rotation-title" className="grid gap-6">
            <h2 id="rotation-title" className="sr-only">
                Rotation
            </h2>
            <p className="m-0 max-w-[65ch] text-[13px] text-text-muted">
                Every open lead is due a touch — an email or reply, a call or note, a completed task, a meeting, or a
                stage move — by its stage’s cadence. One missed cadence warns its owner; if the grace passes without a
                touch, the lead moves to the next rep in turn. Switching rotation on never moves an old backlog at once:
                lapses are measured from that moment.
            </p>
            {current && (
                <div className="grid max-w-[65ch] gap-4">
                    <SwitchRow
                        label="Rotate lapsed leads"
                        hint={
                            settings.data?.enabledAt
                                ? `On since ${formatDate(settings.data.enabledAt)}.`
                                : 'Off: leads are flagged overdue, nobody is warned or moved.'
                        }
                        checked={current.enabled}
                        onCheckedChange={(enabled) => change({ enabled })}
                    />
                    <SwitchRow
                        label="Deal new unowned leads in turn"
                        hint="BylineAI and web leads, and imports without an owner, go to the next rep."
                        checked={current.intakeEnabled}
                        onCheckedChange={(intakeEnabled) => change({ intakeEnabled })}
                    />
                    <NumberRow
                        id="warn-after"
                        label="Warn the owner, days after a missed cadence"
                        value={current.warnAfterDays}
                        min={0}
                        onSave={(warnAfterDays) => change({ warnAfterDays: warnAfterDays ?? 0 })}
                    />
                    <NumberRow
                        id="grace"
                        label="Rotate, days after the warning without a touch"
                        value={current.graceDays}
                        min={1}
                        onSave={(graceDays) => change({ graceDays: graceDays ?? 7 })}
                    />
                    <NumberRow
                        id="cap"
                        label="Skip reps holding this many open deals (blank: no cap)"
                        value={current.openLeadCap}
                        min={1}
                        nullable
                        onSave={(openLeadCap) => change({ openLeadCap })}
                    />
                    <SelectField
                        label="Mailboxes"
                        value={current.mailboxPreference}
                        options={MAILBOX_PREFERENCES.map((value) => ({ value, label: MAILBOX_TEXT[value] }))}
                        onValueChange={(mailboxPreference) => change({ mailboxPreference })}
                    />
                </div>
            )}

            <DataTableChrome
                data={{
                    label: 'Reps in the rotation',
                    loading: members.isPending,
                    rows: members.data ?? [],
                    getRowId: (row) => row.memberId,
                    columns: [
                        { id: 'name', header: 'Member', className: 'font-medium', cell: (r) => r.name ?? r.email },
                        { id: 'role', header: 'Role', muted: true, phone: 'hidden', cell: (r) => r.roleName },
                        {
                            id: 'state',
                            header: 'In rotation',
                            cell: (r) =>
                                !r.included ? (
                                    <Badge>Out</Badge>
                                ) : r.paused ? (
                                    <Badge status="warning">
                                        {r.resumeAt ? `Paused until ${formatDate(r.resumeAt)}` : 'Paused'}
                                    </Badge>
                                ) : r.eligible ? (
                                    <Badge status="success">In</Badge>
                                ) : (
                                    <Badge status="warning">Skipped</Badge>
                                ),
                        },
                        { id: 'leads', header: 'Open deals', muted: true, cell: (r) => String(r.openLeads) },
                        { id: 'weight', header: 'Turns', muted: true, phone: 'hidden', cell: (r) => `×${r.weight}` },
                        {
                            id: 'mailbox',
                            header: 'Mailbox',
                            muted: true,
                            phone: 'hidden',
                            cell: (r) => (r.hasMailbox ? 'Connected' : '—'),
                        },
                    ],
                    rowActions: {
                        label: (row) => row.name ?? row.email,
                        items: (row) => (
                            <>
                                {row.included && !row.paused && (
                                    <>
                                        <DropdownMenuItem onSelect={() => member(row, { paused: true })}>
                                            Pause
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                            onSelect={() =>
                                                member(row, { resumeAt: new Date(Date.now() + 7 * DAY).toISOString() })
                                            }
                                        >
                                            Pause for a week
                                        </DropdownMenuItem>
                                    </>
                                )}
                                {row.paused && (
                                    <DropdownMenuItem onSelect={() => member(row, { paused: false })}>
                                        Unpause
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuItem onSelect={() => member(row, { included: !row.included })}>
                                    {row.included ? 'Take out of the rotation' : 'Add to the rotation'}
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => member(row, { weight: (row.weight % 5) + 1 })}>
                                    Turns per round: ×{(row.weight % 5) + 1}
                                </DropdownMenuItem>
                            </>
                        ),
                    },
                }}
            />

            {(pipelines.data ?? []).map((p) => (
                <CadenceSection
                    key={`${p.id}:${p.stages.map((s) => s.cadenceDays).join()}`}
                    workspaceId={workspaceId}
                    pipeline={p}
                    canEdit
                />
            ))}

            <div className="grid gap-3">
                <div className="flex flex-wrap items-center gap-3">
                    <h3 className="m-0 text-sm font-semibold">Preview</h3>
                    <Button size="sm" onClick={() => (previewing ? void preview.refetch() : setPreviewing(true))}>
                        Preview what would rotate
                    </Button>
                    {preview.data && (
                        <span className="text-xs text-text-muted">
                            {preview.data.overdue} overdue lead{preview.data.overdue === 1 ? '' : 's'}
                            {settings.data?.enabled ? '' : ', as if rotation were switched on now'}. Nothing changes.
                        </span>
                    )}
                </div>
                {previewing && (
                    <DataTableChrome
                        data={{
                            label: 'What rotation would do',
                            loading: preview.isPending,
                            rows: preview.data?.items ?? [],
                            getRowId: (row) => row.opportunityId,
                            columns: [
                                {
                                    id: 'deal',
                                    header: 'Deal',
                                    className: 'font-medium',
                                    cell: (r) => r.opportunityName,
                                },
                                {
                                    id: 'stage',
                                    header: 'Stage',
                                    muted: true,
                                    cell: (r) => `${r.stageName} · ${r.cadenceDays}d`,
                                },
                                { id: 'owner', header: 'Owner', cell: (r) => r.owner.name ?? '—' },
                                {
                                    id: 'touch',
                                    header: 'Last touch',
                                    muted: true,
                                    phone: 'hidden',
                                    cell: (r) => formatDate(r.lastTouchAt),
                                },
                                {
                                    id: 'action',
                                    header: 'Next run',
                                    cell: (r) => <Badge status={ACTION_TONE[r.action]}>{ACTION_TEXT[r.action]}</Badge>,
                                },
                                {
                                    id: 'rotates',
                                    header: 'Rotates',
                                    muted: true,
                                    cell: (r) =>
                                        r.action === 'rotate'
                                            ? (r.to?.name ?? 'Nobody eligible')
                                            : formatDate(r.rotateAt),
                                },
                            ],
                        }}
                    />
                )}
            </div>
        </section>
    );
}

/** A whole number setting, saved when the box is left. */
function NumberRow({
    id,
    label,
    value,
    min,
    nullable = false,
    onSave,
}: {
    id: string;
    label: string;
    value: number | null;
    min: number;
    nullable?: boolean;
    onSave: (value: number | null) => void;
}) {
    const [text, setText] = useState(value === null ? '' : String(value));
    const commit = () => {
        if (text === '' && nullable) return value === null ? undefined : onSave(null);
        const n = Number(text);
        if (!Number.isInteger(n) || n < min || n > 90 * (nullable ? 100 : 1)) {
            setText(value === null ? '' : String(value));
            return;
        }
        if (n !== value) onSave(n);
    };
    return (
        <div className="flex flex-wrap items-center gap-3">
            <label htmlFor={id} className="min-w-72 text-sm">
                {label}
            </label>
            <Input
                id={id}
                className="w-24"
                inputMode="numeric"
                value={text}
                onChange={(e) => setText(e.target.value.trim())}
                onBlur={commit}
            />
        </div>
    );
}
