import {
    BIGIN_DATA_CENTRES,
    BIGIN_IMPORT_OBJECT_LABELS,
    TWENTY_SYNC_FAILURES_BEFORE_NOTICE,
    type BiginImportMode,
    type BiginImportObject,
    type TwentySyncInterval,
} from '@bylinecrm/shared';
import {
    Badge,
    Button,
    DataTableChrome,
    Field,
    Input,
    LoadingRegion,
    SegmentedControl,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Skeleton,
    toast,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { fieldErrorAt } from '../../../api/client';
import {
    useBiginContactReuses,
    useBiginCutover,
    useBiginImport,
    useBiginImportMissing,
    useBiginImportRun,
    useBiginImportRuns,
    useBiginPreview,
    useCancelBiginImport,
    usePutBiginSettings,
    usePutBiginSync,
    useRemoveBiginSettings,
    useStartBiginImport,
} from '../../../api/importBigin';
import { isFinalRun } from '../../../api/importTwenty';
import type {
    BiginImportObjectReportView,
    BiginImportOverviewView,
    BiginImportPreviewView,
    BiginImportRunView,
} from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { formatDate, formatWhen } from '../../../lib/format';
import { useWorkspaceId } from '../../params';

/**
 * The Bigin importer's screen (BIGIN-1, FR-CRMS-25): connect Zoho Bigin, sync it one way into BylineCRM by
 * hand or on a schedule, follow a run module by module — failures said per module, zero included — and
 * review what Bigin deleted and which Contacts were reused for another person. The API is the gate.
 */
export function ImportBigin() {
    const workspaceId = useWorkspaceId();
    const admin = useCan('workspace:admin');
    return (
        <section aria-labelledby="import-bigin-title" className="max-w-4xl">
            <h2 id="import-bigin-title" className="m-0 mb-1 text-base font-semibold">
                Import from Bigin
            </h2>
            <p className="m-0 mb-5 text-[13px] text-text-muted">
                Syncs Zoho Bigin into BylineCRM, one way. Every record is mapped by its Bigin id, so a run can be
                repeated: what changed is updated, what did not is left alone, and nothing is imported twice — not even
                a record that already came over from Twenty.
            </p>
            {admin ? (
                <AdminImporter workspaceId={workspaceId} />
            ) : (
                <p className="m-0 text-[13px] text-text-muted">
                    An admin connects Bigin and runs the sync; ask one of yours.
                </p>
            )}
        </section>
    );
}

function AdminImporter({ workspaceId }: { workspaceId: string }) {
    const overview = useBiginImport(workspaceId);
    if (overview.isError) throw overview.error;
    if (!overview.data) {
        return (
            <LoadingRegion label="Loading the importer" className="flex flex-col gap-4">
                <Skeleton className="h-40" />
                <Skeleton className="h-24" />
            </LoadingRegion>
        );
    }
    return (
        <div className="flex flex-col gap-4">
            <Connection workspaceId={workspaceId} overview={overview.data} />
            {overview.data.settings.configured && (
                <>
                    <SyncCard workspaceId={workspaceId} overview={overview.data} />
                    <RunCard workspaceId={workspaceId} overview={overview.data} />
                    <Reuses workspaceId={workspaceId} />
                    <Missing workspaceId={workspaceId} />
                    <History workspaceId={workspaceId} />
                </>
            )}
        </div>
    );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
            <h3 className="m-0 mb-3 text-sm font-semibold">{title}</h3>
            {children}
        </div>
    );
}

const number = new Intl.NumberFormat();
const count = (n: number | null | undefined) => (n === null || n === undefined ? '—' : number.format(n));
const label = (object: BiginImportObject) => BIGIN_IMPORT_OBJECT_LABELS[object].label;

function Alert({ children }: { children: React.ReactNode }) {
    return (
        <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {children}
        </p>
    );
}

function Connection({ workspaceId, overview }: { workspaceId: string; overview: BiginImportOverviewView }) {
    const { settings } = overview;
    const [replacing, setReplacing] = useState(false);
    const [removing, setRemoving] = useState(false);
    const remove = useRemoveBiginSettings(workspaceId);
    const preview = useBiginPreview(workspaceId);
    if (!settings.configured || replacing) {
        return (
            <Card title="Connection">
                <ConnectionForm
                    workspaceId={workspaceId}
                    overview={overview}
                    {...(settings.configured ? { onCancel: () => setReplacing(false) } : {})}
                    onSaved={() => setReplacing(false)}
                />
            </Card>
        );
    }
    const previewError = preview.isError
        ? (fieldErrorAt(preview.error, 'refreshToken') ?? failureText(preview.error))
        : undefined;
    return (
        <Card title="Connection">
            <div className="flex flex-col gap-3">
                <dl className="m-0 grid gap-2 text-[13px] md:grid-cols-[8rem_1fr]">
                    <dt className="text-text-muted">Zoho API</dt>
                    <dd className="m-0 break-all">
                        <code className="text-xs">{settings.apiUrl}</code>
                    </dd>
                    <dt className="text-text-muted">Client id</dt>
                    <dd className="m-0 break-all">
                        <code className="text-xs">{settings.clientId}</code>
                    </dd>
                    <dt className="text-text-muted">Refresh token</dt>
                    <dd className="m-0">
                        <code className="text-xs">•••• {settings.refreshTokenLast4}</code>
                    </dd>
                </dl>
                <div className="flex flex-wrap gap-2">
                    <Button
                        shape="square"
                        size="sm"
                        className="max-md:h-touch"
                        loading={preview.isPending}
                        onClick={() => preview.mutate()}
                    >
                        Check connection
                    </Button>
                    <Button shape="square" size="sm" className="max-md:h-touch" onClick={() => setReplacing(true)}>
                        Replace credentials
                    </Button>
                    <Button
                        shape="square"
                        size="sm"
                        variant="ghost"
                        className="text-danger max-md:h-touch"
                        onClick={() => {
                            remove.reset();
                            setRemoving(true);
                        }}
                    >
                        Remove connection
                    </Button>
                </div>
                {previewError && <Alert>{previewError}</Alert>}
                {preview.data && <PreviewTable preview={preview.data} />}
            </div>
            <ConfirmDialog
                open={removing}
                onOpenChange={setRemoving}
                title="Remove the Bigin connection?"
                body="The credentials are forgotten and the automatic sync stops. What was imported stays, and a new connection picks up where this one left off."
                confirm="Remove connection"
                pending={remove.isPending}
                error={remove.isError ? failureText(remove.error) : undefined}
                onConfirm={() =>
                    remove.mutate(undefined, {
                        onSuccess: () => {
                            setRemoving(false);
                            toast({ title: 'Bigin connection removed' });
                        },
                    })
                }
            />
        </Card>
    );
}

function ConnectionForm({
    workspaceId,
    overview,
    onCancel,
    onSaved,
}: {
    workspaceId: string;
    overview: BiginImportOverviewView;
    onCancel?: () => void;
    onSaved: () => void;
}) {
    const put = usePutBiginSettings(workspaceId);
    const { settings } = overview;
    const known = BIGIN_DATA_CENTRES.find((dc) => dc.apiUrl === settings.apiUrl);
    const [centre, setCentre] = useState<string>(known?.code ?? BIGIN_DATA_CENTRES[0].code);
    const [clientId, setClientId] = useState(settings.clientId ?? '');
    const [clientSecret, setClientSecret] = useState('');
    const [refreshToken, setRefreshToken] = useState('');
    const dc = BIGIN_DATA_CENTRES.find((d) => d.code === centre) ?? BIGIN_DATA_CENTRES[0];
    const needsSecrets = !settings.configured;
    const submit = (event: FormEvent) => {
        event.preventDefault();
        put.mutate(
            {
                accountsUrl: dc.accountsUrl,
                apiUrl: dc.apiUrl,
                clientId: clientId.trim(),
                ...(clientSecret ? { clientSecret } : {}),
                ...(refreshToken ? { refreshToken } : {}),
            },
            {
                onSuccess: () => {
                    setClientSecret('');
                    setRefreshToken('');
                    toast({ title: 'Bigin connection saved', description: 'Check it, then start a sync.' });
                    onSaved();
                },
            },
        );
    };
    const fieldError = (path: string) => fieldErrorAt(put.error, path);
    const generalError =
        put.isError && !['clientId', 'clientSecret', 'refreshToken', 'apiUrl', 'accountsUrl'].some(fieldError)
            ? failureText(put.error)
            : undefined;
    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <Field label="Data centre" hint="Where the Zoho account lives: the domain you sign in to Bigin on.">
                <Select value={centre} onValueChange={setCentre}>
                    <SelectTrigger aria-label="Data centre">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {BIGIN_DATA_CENTRES.map((option) => (
                            <SelectItem key={option.code} value={option.code}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Field>
            <Field
                label="Client id"
                required
                hint="From Zoho’s API console (a self client)."
                error={fieldError('clientId')}
            >
                <Input
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                />
            </Field>
            <Field
                label="Client secret"
                required={needsSecrets}
                hint={needsSecrets ? 'Stored encrypted; never shown again.' : 'Leave empty to keep the stored one.'}
                error={fieldError('clientSecret')}
            >
                <Input
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                />
            </Field>
            <Field
                label="Refresh token"
                required={needsSecrets}
                hint="A refresh token granted for the Bigin modules (ZohoBigin.modules.ALL). Stored encrypted; afterwards only its last four characters are shown."
                error={fieldError('refreshToken')}
            >
                <Input
                    type="password"
                    value={refreshToken}
                    onChange={(e) => setRefreshToken(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                />
            </Field>
            {generalError && <Alert>{generalError}</Alert>}
            <div className="flex gap-2">
                {onCancel && (
                    <Button type="button" shape="square" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
                <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    data-primary-action
                    loading={put.isPending}
                    disabled={!clientId.trim() || (needsSecrets && (!clientSecret || !refreshToken))}
                >
                    Save connection
                </Button>
            </div>
        </form>
    );
}

function PreviewTable({ preview }: { preview: BiginImportPreviewView }) {
    type Row = BiginImportPreviewView['objects'][number];
    return (
        <section aria-label="Counts per module" className="flex flex-col gap-2">
            <p className="m-0 text-[13px] text-text-muted">Bigin answered at {formatDate(preview.checkedAt)}.</p>
            <DataTableChrome
                data={{
                    label: 'Counts per module',
                    rows: preview.objects,
                    getRowId: (row: Row) => row.object,
                    columns: [
                        {
                            id: 'object',
                            header: 'Module',
                            className: 'font-medium',
                            cell: (row: Row) => label(row.object),
                        },
                        {
                            id: 'lands',
                            header: 'Lands as',
                            muted: true,
                            phone: 'hidden',
                            cell: (row: Row) => BIGIN_IMPORT_OBJECT_LABELS[row.object].lands,
                        },
                        {
                            id: 'remote',
                            header: 'In Bigin',
                            phone: 'secondary',
                            cell: (row: Row) =>
                                row.error ? <span className="text-danger">{row.error}</span> : count(row.remote),
                        },
                        {
                            id: 'linked',
                            header: 'Mapped here',
                            phone: 'secondary',
                            cell: (row: Row) => count(row.linked),
                        },
                    ],
                }}
            />
        </section>
    );
}

const SYNC_INTERVALS: readonly { value: TwentySyncInterval; label: string }[] = [
    { value: 'off', label: 'Off' },
    { value: '15m', label: 'Every 15 minutes' },
    { value: 'hourly', label: 'Hourly' },
    { value: 'daily', label: 'Daily' },
];

function SyncCard({ workspaceId, overview }: { workspaceId: string; overview: BiginImportOverviewView }) {
    const { sync } = overview;
    const put = usePutBiginSync(workspaceId);
    const cutover = useBiginCutover(workspaceId);
    const [stopping, setStopping] = useState(false);
    const on = sync.interval !== 'off';
    return (
        <Card title="Automatic sync">
            <div className="flex flex-col gap-3 text-[13px]">
                <p className="m-0 text-text-muted">
                    Reads what Bigin changed since each module’s cursor. Bigin is the source for the fields it maps; a
                    field edited here after Bigin last changed the record keeps its value. Owners are set when a record
                    is created, never after. Records deleted in Bigin are flagged for review, never deleted here.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                    <div className="w-56">
                        <Select
                            value={sync.interval}
                            onValueChange={(value) => put.mutate({ interval: value as TwentySyncInterval })}
                            disabled={put.isPending}
                        >
                            <SelectTrigger aria-label="Automatic sync">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {SYNC_INTERVALS.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>
                                        {option.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {on && sync.nextRunAt && (
                        <span className="text-text-muted">Next sync {formatWhen(sync.nextRunAt)}</span>
                    )}
                    {on && (
                        <Button
                            shape="square"
                            size="sm"
                            variant="ghost"
                            className="text-danger max-md:h-touch"
                            onClick={() => {
                                cutover.reset();
                                setStopping(true);
                            }}
                        >
                            Stop syncing (cutover)
                        </Button>
                    )}
                </div>
                {put.isError && <Alert>{failureText(put.error)}</Alert>}
                {sync.failures > 0 && (
                    <p
                        className={`m-0 ${sync.failures >= TWENTY_SYNC_FAILURES_BEFORE_NOTICE ? 'text-danger' : 'text-warning'}`}
                    >
                        {`${sync.failures} automatic sync${sync.failures === 1 ? '' : 's'} in a row failed: ${sync.lastError ?? 'the run failed'}. `}
                        {sync.failures >= TWENTY_SYNC_FAILURES_BEFORE_NOTICE
                            ? 'Admins have been emailed; the schedule keeps trying, less often each time.'
                            : 'The schedule tries again, less often each time.'}
                    </p>
                )}
                {!on && sync.cutoverAt && (
                    <p className="m-0 text-text-muted">{`Syncing stopped ${formatDate(sync.cutoverAt)} (cutover).`}</p>
                )}
                <p className="m-0 text-text-muted">
                    {overview.cursors
                        .map((c) => `${label(c.object)}: ${c.since ? `from ${formatDate(c.since)}` : 'not read yet'}`)
                        .join(' · ')}
                </p>
            </div>
            <ConfirmDialog
                open={stopping}
                onOpenChange={setStopping}
                title="Stop syncing with Bigin?"
                body="The schedule is turned off for good and this moment is recorded as the cutover. What was imported stays, and a sync can still be run by hand."
                confirm="Stop syncing"
                pending={cutover.isPending}
                error={cutover.isError ? failureText(cutover.error) : undefined}
                onConfirm={() =>
                    cutover.mutate(undefined, {
                        onSuccess: () => {
                            setStopping(false);
                            toast({ title: 'Syncing with Bigin stopped' });
                        },
                    })
                }
            />
        </Card>
    );
}

const MODES: readonly { value: BiginImportMode; label: string }[] = [
    { value: 'changes', label: 'Changes since the cursor' },
    { value: 'full', label: 'Everything' },
];

function RunCard({ workspaceId, overview }: { workspaceId: string; overview: BiginImportOverviewView }) {
    const [mode, setMode] = useState<BiginImportMode>('changes');
    const start = useStartBiginImport(workspaceId);
    const cancel = useCancelBiginImport(workspaceId);
    const latest = overview.latestRun;
    const run = useBiginImportRun(workspaceId, latest?.id ?? null, latest);
    const current = run.data ?? latest ?? null;
    const going = current !== null && !isFinalRun(current);
    return (
        <Card title="Sync now">
            <div className="flex flex-col gap-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-3">
                    <SegmentedControl aria-label="What to read" options={MODES} value={mode} onValueChange={setMode} />
                    <Button
                        variant="primary"
                        shape="square"
                        size="sm"
                        className="max-md:h-touch"
                        loading={start.isPending}
                        disabled={going}
                        onClick={() => start.mutate({ mode })}
                    >
                        Start sync
                    </Button>
                    {going && current && (
                        <Button
                            shape="square"
                            size="sm"
                            variant="ghost"
                            className="max-md:h-touch"
                            loading={cancel.isPending}
                            onClick={() => cancel.mutate(current.id)}
                        >
                            Cancel sync
                        </Button>
                    )}
                </div>
                {start.isError && (
                    <Alert>{fieldErrorAt(start.error, 'refreshToken') ?? failureText(start.error)}</Alert>
                )}
                {current && <RunReport run={current} />}
            </div>
        </Card>
    );
}

type Tone = 'neutral' | 'info' | 'success' | 'danger' | 'warning';

function statusOf(run: BiginImportRunView): { text: string; tone: Tone } {
    if (run.status === 'succeeded' && run.failedRecords > 0) {
        return { text: `Finished with ${count(run.failedRecords)} failed`, tone: 'warning' };
    }
    const text: Record<BiginImportRunView['status'], string> = {
        queued: 'Queued',
        running: 'Running',
        succeeded: 'Finished',
        failed: 'Failed',
        cancelled: 'Cancelled',
    };
    const tone: Tone =
        run.status === 'failed'
            ? 'danger'
            : run.status === 'succeeded'
              ? 'success'
              : run.status === 'running'
                ? 'info'
                : 'neutral';
    return { text: text[run.status], tone };
}

function RunReport({ run }: { run: BiginImportRunView }) {
    type Row = BiginImportObjectReportView;
    const status = statusOf(run);
    const stages = run.report.flatMap((r) => r.unknownStages);
    const errors = run.report.flatMap((r) => r.errors.map((e) => ({ ...e, object: r.object })));
    return (
        <section aria-label="Run report" className="flex flex-col gap-2">
            <p className="m-0 flex flex-wrap items-center gap-2">
                <Badge status={status.tone} dot>
                    {status.text}
                </Badge>
                <span className="text-text-muted">
                    {run.scheduled ? 'Automatic' : 'Started by hand'} · {formatWhen(run.queuedAt)}
                    {run.phase ? ` · reading ${label(run.phase)}` : ''}
                </span>
            </p>
            {run.error && <Alert>{run.error}</Alert>}
            <DataTableChrome
                data={{
                    label: 'Run report',
                    rows: run.report,
                    getRowId: (row: Row) => row.object,
                    columns: [
                        {
                            id: 'object',
                            header: 'Module',
                            className: 'font-medium',
                            cell: (row: Row) => label(row.object),
                        },
                        { id: 'read', header: 'Read', phone: 'secondary', cell: (row: Row) => count(row.read) },
                        {
                            id: 'created',
                            header: 'Created',
                            phone: 'secondary',
                            cell: (row: Row) => count(row.created),
                        },
                        {
                            id: 'updated',
                            header: 'Updated',
                            phone: 'secondary',
                            cell: (row: Row) => count(row.updated),
                        },
                        { id: 'merged', header: 'Merged', phone: 'secondary', cell: (row: Row) => count(row.merged) },
                        {
                            id: 'skipped',
                            header: 'Skipped',
                            phone: 'secondary',
                            cell: (row: Row) => count(row.skipped),
                        },
                        {
                            id: 'failed',
                            header: 'Failed',
                            phone: 'secondary',
                            cell: (row: Row) => (
                                <span className={row.failed > 0 ? 'font-semibold text-danger' : undefined}>
                                    {count(row.failed)}
                                </span>
                            ),
                        },
                        { id: 'reused', header: 'Reused', phone: 'secondary', cell: (row: Row) => count(row.reused) },
                        {
                            id: 'missing',
                            header: 'Deleted in Bigin',
                            phone: 'secondary',
                            cell: (row: Row) => count(row.missingInSource),
                        },
                    ],
                }}
            />
            {stages.length > 0 && (
                <p className="m-0 text-text-muted">
                    {`Stages with no match here, placed in the first open stage: ${[...new Set(stages.map((s) => s.stage))].join(', ')}.`}
                </p>
            )}
            {errors.length > 0 && (
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-text-muted">
                    {errors.map((e) => (
                        <li key={`${e.object}:${e.externalId}:${e.message}`}>
                            {`${label(e.object)} ${e.externalId}: ${e.message}`}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/** Contacts edited in Bigin into someone else: the earlier person was kept, a new one made. */
function Reuses({ workspaceId }: { workspaceId: string }) {
    const reuses = useBiginContactReuses(workspaceId);
    type Row = NonNullable<typeof reuses.data>['items'][number];
    const who = (identity: Row['before']) => `${identity.name || '(no name)'} <${identity.email ?? 'no email'}>`;
    return (
        <Card title="Reused Bigin contacts">
            {reuses.isError ? (
                <Alert>{failureText(reuses.error)}</Alert>
            ) : !reuses.data ? (
                <Skeleton className="h-12" />
            ) : reuses.data.items.length === 0 ? (
                <p className="m-0 text-[13px] text-text-muted">No Bigin contact has been reused for another person.</p>
            ) : (
                <DataTableChrome
                    data={{
                        label: 'Reused Bigin contacts',
                        rows: reuses.data.items,
                        getRowId: (row: Row) => row.id,
                        columns: [
                            { id: 'when', header: 'When', cell: (row: Row) => formatDate(row.detectedAt) },
                            { id: 'before', header: 'Before', phone: 'secondary', cell: (row: Row) => who(row.before) },
                            { id: 'after', header: 'After', phone: 'secondary', cell: (row: Row) => who(row.after) },
                            {
                                id: 'bigin',
                                header: 'Bigin id',
                                muted: true,
                                phone: 'hidden',
                                cell: (row: Row) => row.biginId,
                            },
                        ],
                    }}
                />
            )}
        </Card>
    );
}

function Missing({ workspaceId }: { workspaceId: string }) {
    const missing = useBiginImportMissing(workspaceId);
    type Row = NonNullable<typeof missing.data>['items'][number];
    if (!missing.data || missing.data.items.length === 0) return null;
    return (
        <Card title="Deleted in Bigin">
            <p className="m-0 mb-2 text-[13px] text-text-muted">
                Bigin deleted these; they stay here until someone decides. A record seen in Bigin again is cleared.
            </p>
            <DataTableChrome
                data={{
                    label: 'Deleted in Bigin',
                    rows: missing.data.items,
                    getRowId: (row: Row) => `${row.object}:${row.externalId}`,
                    columns: [
                        { id: 'name', header: 'Record', cell: (row: Row) => row.name ?? row.localId },
                        { id: 'object', header: 'Module', phone: 'secondary', cell: (row: Row) => label(row.object) },
                        {
                            id: 'since',
                            header: 'Deleted',
                            phone: 'secondary',
                            cell: (row: Row) => formatDate(row.missingSince),
                        },
                    ],
                }}
            />
        </Card>
    );
}

function History({ workspaceId }: { workspaceId: string }) {
    const runs = useBiginImportRuns(workspaceId);
    type Row = BiginImportRunView;
    if (!runs.data || runs.data.length === 0) return null;
    return (
        <Card title="Previous runs">
            <DataTableChrome
                data={{
                    label: 'Previous runs',
                    rows: runs.data,
                    getRowId: (row: Row) => row.id,
                    columns: [
                        { id: 'when', header: 'Started', cell: (row: Row) => formatWhen(row.queuedAt) },
                        {
                            id: 'status',
                            header: 'Status',
                            phone: 'secondary',
                            cell: (row: Row) => {
                                const status = statusOf(row);
                                return (
                                    <Badge status={status.tone} dot>
                                        {status.text}
                                    </Badge>
                                );
                            },
                        },
                        {
                            id: 'how',
                            header: 'How',
                            muted: true,
                            phone: 'secondary',
                            cell: (row: Row) =>
                                `${row.scheduled ? 'Automatic' : 'By hand'} · ${row.mode === 'full' ? 'Everything' : 'Changes'}`,
                        },
                        {
                            id: 'failed',
                            header: 'Failed',
                            phone: 'secondary',
                            cell: (row: Row) => count(row.failedRecords),
                        },
                    ],
                }}
            />
        </Card>
    );
}
