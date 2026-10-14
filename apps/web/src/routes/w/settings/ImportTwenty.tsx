import {
    SYSTEM_ROLES,
    TWENTY_IMPORT_OBJECT_LABELS,
    TWENTY_IMPORT_OBJECTS,
    type TwentyImportCreateMembers,
    type TwentyImportMode,
    type TwentyImportObject,
    type TwentyImportRunStatus,
} from '@bylinecrm/shared';
import {
    Badge,
    Button,
    Checkbox,
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
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { fieldErrorAt } from '../../../api/client';
import {
    isFinalRun,
    useCancelTwentyImport,
    usePutTwentySettings,
    useRemoveTwentySettings,
    useStartTwentyImport,
    useTwentyImport,
    useTwentyImportRun,
    useTwentyImportRuns,
    useTwentyPreview,
    useTwentyImportMissing,
} from '../../../api/importTwenty';
import { keys } from '../../../api/queries';
import { useRoles } from '../../../api/team';
import type {
    TwentyImportObjectReportView,
    TwentyImportOverviewView,
    TwentyImportPreviewView,
    TwentyImportRunView,
} from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';

/**
 * The importer screen (P4-UI-2, doc 48 §11): connect a Twenty workspace, see what it holds beside
 * what is mapped here, run the import and follow it object by object. The API is the gate; this
 * page decides what to offer. A member who is not an admin is told whose it is.
 */
export function ImportTwenty() {
    const workspaceId = useWorkspaceId();
    const admin = useCan('workspace:admin');
    return (
        <section aria-labelledby="import-twenty-title" className="max-w-4xl">
            <h2 id="import-twenty-title" className="m-0 mb-1 text-base font-semibold">
                Import from Twenty
            </h2>
            <p className="m-0 mb-5 text-[13px] text-text-muted">
                Reads a Twenty workspace through its API and maps every record by its Twenty id, so the import can be
                run again: what changed is updated, what did not is left alone, and nothing is imported twice.
            </p>
            {admin ? (
                <AdminImporter workspaceId={workspaceId} />
            ) : (
                <p className="m-0 text-[13px] text-text-muted">
                    An admin connects the Twenty workspace and runs the import; ask one of yours.
                </p>
            )}
        </section>
    );
}

function AdminImporter({ workspaceId }: { workspaceId: string }) {
    const overview = useTwentyImport(workspaceId);
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
            {overview.data.settings.configured && <Runs workspaceId={workspaceId} overview={overview.data} />}
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

/** The connection: write-only key, shown by its last four characters once saved; a check reads Twenty's counts. */
function Connection({ workspaceId, overview }: { workspaceId: string; overview: TwentyImportOverviewView }) {
    const { settings } = overview;
    // The form shows until a connection exists, and again when an admin asks to replace the key.
    const [replacing, setReplacing] = useState(false);
    const editing = !settings.configured || replacing;
    const setEditing = setReplacing;
    const [removing, setRemoving] = useState(false);
    const remove = useRemoveTwentySettings(workspaceId);
    const preview = useTwentyPreview(workspaceId);
    if (editing) {
        return (
            <Card title="Connection">
                <ConnectionForm
                    workspaceId={workspaceId}
                    initialBaseUrl={settings.baseUrl ?? ''}
                    {...(settings.configured ? { onCancel: () => setEditing(false) } : {})}
                    onSaved={() => setEditing(false)}
                />
            </Card>
        );
    }
    const previewError = preview.isError
        ? (fieldErrorAt(preview.error, 'apiKey') ?? failureText(preview.error))
        : undefined;
    return (
        <Card title="Connection">
            <div className="flex flex-col gap-3">
                <dl className="m-0 grid gap-2 text-[13px] md:grid-cols-[8rem_1fr]">
                    <dt className="text-text-muted">Twenty URL</dt>
                    <dd className="m-0 break-all">
                        <code className="text-xs">{settings.baseUrl}</code>
                    </dd>
                    <dt className="text-text-muted">API key</dt>
                    <dd className="m-0">
                        <code className="text-xs">•••• {settings.apiKeyLast4}</code>
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
                    <Button shape="square" size="sm" className="max-md:h-touch" onClick={() => setEditing(true)}>
                        Replace key
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
                {previewError && (
                    <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
                        {previewError}
                    </p>
                )}
                {preview.data && <PreviewTable preview={preview.data} />}
                {preview.data && preview.data.accountsToCreate !== null && (
                    <p className="m-0 mt-2 text-[13px] text-text-muted">
                        {preview.data.accountsToCreate === 0
                            ? 'Every Twenty member with an address is here already.'
                            : `${count(preview.data.accountsToCreate)} ${preview.data.accountsToCreate === 1 ? 'account' : 'accounts'} would be created for Twenty members who aren’t here, with the import option on.`}
                    </p>
                )}
            </div>
            <ConfirmDialog
                open={removing}
                onOpenChange={setRemoving}
                title="Remove the Twenty connection?"
                body="The key is forgotten. What was imported stays, and a new connection picks up where this one left off."
                confirm="Remove connection"
                pending={remove.isPending}
                error={remove.isError ? failureText(remove.error) : undefined}
                onConfirm={() =>
                    remove.mutate(undefined, {
                        onSuccess: () => {
                            setRemoving(false);
                            toast({ title: 'Twenty connection removed' });
                        },
                    })
                }
            />
        </Card>
    );
}

function ConnectionForm({
    workspaceId,
    initialBaseUrl,
    onCancel,
    onSaved,
}: {
    workspaceId: string;
    initialBaseUrl: string;
    onCancel?: () => void;
    onSaved: () => void;
}) {
    const put = usePutTwentySettings(workspaceId);
    const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
    const [apiKey, setApiKey] = useState('');
    const submit = (event: FormEvent) => {
        event.preventDefault();
        put.mutate(
            { baseUrl: baseUrl.trim(), apiKey },
            {
                onSuccess: () => {
                    // The key leaves the page's memory once it is saved; only its last four come back.
                    setApiKey('');
                    toast({ title: 'Twenty connection saved', description: 'Check it, then start the import.' });
                    onSaved();
                },
            },
        );
    };
    const generalError =
        put.isError && !fieldErrorAt(put.error, 'baseUrl') && !fieldErrorAt(put.error, 'apiKey')
            ? failureText(put.error)
            : undefined;
    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <Field
                label="Twenty URL"
                required
                hint="The workspace’s address, e.g. https://crm.example.com"
                error={fieldErrorAt(put.error, 'baseUrl')}
            >
                <Input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    inputMode="url"
                />
            </Field>
            <Field
                label="API key"
                required
                hint="From Twenty’s settings, under APIs. Stored encrypted; afterwards only its last four characters are shown."
                error={fieldErrorAt(put.error, 'apiKey')}
            >
                <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                />
            </Field>
            {generalError && (
                <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
                    {generalError}
                </p>
            )}
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
                    disabled={!baseUrl.trim() || !apiKey}
                >
                    Save connection
                </Button>
            </div>
        </form>
    );
}

const number = new Intl.NumberFormat();
const count = (n: number | null | undefined) => (n === null || n === undefined ? '—' : number.format(n));
const label = (object: TwentyImportObject) => TWENTY_IMPORT_OBJECT_LABELS[object].label;

function PreviewTable({ preview }: { preview: TwentyImportPreviewView }) {
    type Row = TwentyImportPreviewView['objects'][number];
    return (
        <section aria-label="Counts per object" className="flex flex-col gap-2">
            <p className="m-0 text-[13px] text-text-muted">
                Twenty answered at {formatDate(preview.checkedAt)}. “In Twenty” is what a run reads; “Mapped here” is
                what earlier runs already brought over.
            </p>
            <DataTableChrome
                data={{
                    label: 'Counts per object',
                    rows: preview.objects,
                    getRowId: (row: Row) => row.object,
                    columns: [
                        {
                            id: 'object',
                            header: 'Object',
                            className: 'font-medium',
                            cell: (row: Row) => label(row.object),
                        },
                        {
                            id: 'lands',
                            header: 'Lands as',
                            muted: true,
                            phone: 'hidden',
                            cell: (row: Row) => TWENTY_IMPORT_OBJECT_LABELS[row.object].lands,
                        },
                        {
                            id: 'remote',
                            header: 'In Twenty',
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

const STATUS: Record<
    TwentyImportRunStatus,
    { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' | 'warning' }
> = {
    queued: { label: 'Queued', tone: 'neutral' },
    running: { label: 'Running', tone: 'info' },
    succeeded: { label: 'Succeeded', tone: 'success' },
    failed: { label: 'Failed', tone: 'danger' },
    cancelled: { label: 'Cancelled', tone: 'warning' },
};

const MODES: readonly { value: TwentyImportMode; label: string }[] = [
    { value: 'full', label: 'Everything' },
    { value: 'changes', label: 'Changes since last run' },
    { value: 'reconcile', label: 'Reconcile with Twenty' },
];

/** How a count of each object reads: "1 company", "3 people". */
const OBJECT_NOUN: Record<TwentyImportObject, { one: string; many: string }> = {
    workspaceMembers: { one: 'owner', many: 'owners' },
    companies: { one: 'company', many: 'companies' },
    people: { one: 'person', many: 'people' },
    opportunities: { one: 'opportunity', many: 'opportunities' },
    notes: { one: 'note', many: 'notes' },
    tasks: { one: 'task', many: 'tasks' },
    leadLookups: { one: 'lead lookup', many: 'lead lookups' },
    leadViews: { one: 'lead view', many: 'lead views' },
    messageLists: { one: 'message list', many: 'message lists' },
    messageListMembers: { one: 'list member', many: 'list members' },
    messageCampaigns: { one: 'campaign', many: 'campaigns' },
};

const MODE_LABEL: Record<TwentyImportMode, string> = {
    full: 'Everything',
    changes: 'Changes',
    reconcile: 'Reconcile',
};

const MODE_HELP: Record<TwentyImportMode, string> = {
    full: 'Reads every record. One already here is updated where it differs and otherwise left alone.',
    changes: 'Reads only what Twenty changed since the last successful run; without one, everything.',
    reconcile:
        'Writes nothing. Reads every id Twenty still has and flags the records here that it no longer returns as missing in Twenty, for you to review — nothing is deleted on its own.',
};

/** Start a run and follow the latest one; what earlier runs did is listed under it. */
function Runs({ workspaceId, overview }: { workspaceId: string; overview: TwentyImportOverviewView }) {
    const client = useQueryClient();
    const start = useStartTwentyImport(workspaceId);
    const cancel = useCancelTwentyImport(workspaceId);
    const runs = useTwentyImportRuns(workspaceId);
    const [mode, setMode] = useState<TwentyImportMode>('full');
    const [createMembers, setCreateMembers] = useState<TwentyImportCreateMembers | null>(null);
    const [stopping, setStopping] = useState<string | null>(null);
    const latestId = overview.latestRun?.id ?? null;
    const latest = useTwentyImportRun(workspaceId, latestId, overview.latestRun);
    const run = latest.data ?? overview.latestRun;
    const live = run !== null && !isFinalRun(run);
    // Once a run is over, what is mapped and the run list have changed: read them again, once per run.
    const settled = useRef<string | null>(null);
    useEffect(() => {
        if (!run || !isFinalRun(run) || settled.current === run.id) return;
        settled.current = run.id;
        void client.invalidateQueries({ queryKey: keys.twentyImportRuns(workspaceId) });
        void client.invalidateQueries({ queryKey: keys.twentyImport(workspaceId), exact: true });
    }, [client, workspaceId, run]);
    const startError = start.isError ? (fieldErrorAt(start.error, 'apiKey') ?? failureText(start.error)) : undefined;
    return (
        <>
            <Card title="Import">
                {live && run ? (
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-wrap items-center gap-2 text-[13px]">
                            <Badge status={STATUS[run.status].tone} dot>
                                {STATUS[run.status].label}
                            </Badge>
                            {run.phase && (
                                <span className="text-text-muted">Reading {label(run.phase).toLowerCase()}…</span>
                            )}
                            {(stopping === run.id || run.cancelRequested) && (
                                <span className="text-text-muted">Stopping after this page…</span>
                            )}
                            <Button
                                shape="square"
                                size="sm"
                                variant="ghost"
                                className="text-danger max-md:h-touch"
                                loading={cancel.isPending}
                                disabled={stopping === run.id || run.cancelRequested}
                                onClick={() => cancel.mutate(run.id, { onSuccess: () => setStopping(run.id) })}
                            >
                                Cancel import
                            </Button>
                        </div>
                        <ReportTable report={run.report} />
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        <SegmentedControl
                            aria-label="What to import"
                            options={MODES}
                            value={mode}
                            onValueChange={setMode}
                        />
                        <p className="m-0 text-[13px] text-text-muted">{MODE_HELP[mode]}</p>
                        {mode !== 'reconcile' && (
                            <CreateMembersOption
                                workspaceId={workspaceId}
                                value={createMembers}
                                onChange={setCreateMembers}
                            />
                        )}
                        {startError && (
                            <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
                                {startError}
                            </p>
                        )}
                        <div>
                            <Button
                                variant="primary"
                                shape="square"
                                data-primary-action
                                loading={start.isPending}
                                onClick={() =>
                                    start.mutate({
                                        mode,
                                        ...(createMembers && mode !== 'reconcile' ? { createMembers } : {}),
                                    })
                                }
                            >
                                Start import
                            </Button>
                        </div>
                        {run && (
                            <div className="flex flex-col gap-2 border-t border-border pt-3">
                                <RunSummary run={run} />
                                <ReportTable report={run.report} />
                            </div>
                        )}
                    </div>
                )}
            </Card>
            <MissingCard workspaceId={workspaceId} latest={run} />
            <Card title="Previous runs">
                {runs.isError ? (
                    <p role="alert" className="m-0 text-[13px] text-danger">
                        {failureText(runs.error)}
                    </p>
                ) : !runs.data ? (
                    <LoadingRegion label="Loading runs" />
                ) : runs.data.length === 0 ? (
                    <p className="m-0 text-[13px] text-text-muted">No runs yet.</p>
                ) : (
                    <ul className="m-0 flex list-none flex-col gap-2 p-0">
                        {runs.data.map((entry) => (
                            <li key={entry.id} className="text-[13px]">
                                <RunSummary run={entry} />
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
        </>
    );
}

/**
 * The accounts option (#184): create a user and a seat for each Twenty member who is not here, with a
 * role of the workspace's (`member` unless chosen otherwise), so the records they own are theirs
 * from this run. Nothing is mailed; an admin sends the invitation from Members later.
 */
function CreateMembersOption({
    workspaceId,
    value,
    onChange,
}: {
    workspaceId: string;
    value: TwentyImportCreateMembers | null;
    onChange: (value: TwentyImportCreateMembers | null) => void;
}) {
    const roles = useRoles(workspaceId);
    const memberRole = roles.data?.find((r) => r.isSystem && r.name === SYSTEM_ROLES.member) ?? roles.data?.[0];
    const on = value !== null;
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex items-start gap-2 text-[13px]">
                <Checkbox
                    id="import-create-members"
                    aria-labelledby="import-create-members-label"
                    checked={on}
                    disabled={!memberRole}
                    onCheckedChange={(checked) =>
                        onChange(checked === true && memberRole ? { roleId: memberRole.id } : null)
                    }
                />
                <label htmlFor="import-create-members" className="cursor-pointer">
                    <span id="import-create-members-label" className="font-medium">
                        Create accounts for Twenty members who aren’t here
                    </span>
                    <span className="block text-text-muted">
                        Each gets an account with no password and a seat with the role below, so the records they own
                        are theirs. Nothing is emailed: send invitations from Members when you want them to sign in, or
                        they sign in with Google using that address.
                    </span>
                </label>
            </div>
            {on && (
                <Field label="Role for created accounts" className="max-w-xs">
                    <Select value={value.roleId} onValueChange={(roleId) => onChange({ roleId })}>
                        <SelectTrigger aria-label="Role for created accounts">
                            <SelectValue placeholder="Choose a role" />
                        </SelectTrigger>
                        <SelectContent>
                            {(roles.data ?? []).map((r) => (
                                <SelectItem key={r.id} value={r.id}>
                                    {r.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
            )}
        </div>
    );
}

function RunSummary({ run }: { run: TwentyImportRunView }) {
    const totals = run.report.reduce(
        (sum, r) => ({
            created: sum.created + r.created,
            updated: sum.updated + r.updated,
            failed: sum.failed + r.failed,
            missing: sum.missing + (r.missingInSource ?? 0),
        }),
        { created: 0, updated: 0, failed: 0, missing: 0 },
    );
    return (
        <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
                <Badge status={STATUS[run.status].tone} dot>
                    {STATUS[run.status].label}
                </Badge>
                <span className="text-text-muted">
                    {MODE_LABEL[run.mode]} · started {formatDate(run.startedAt ?? run.queuedAt)}
                    {run.finishedAt ? `, finished ${formatDate(run.finishedAt)}` : ''}
                </span>
                <span className="text-text-muted">
                    {run.mode === 'reconcile'
                        ? `${count(totals.missing)} missing in Twenty`
                        : `${count(totals.created)} created, ${count(totals.updated)} updated, ${count(totals.failed)} failed`}
                </span>
                {run.accountsCreated > 0 && (
                    <span className="text-text-muted">
                        {`${count(run.accountsCreated)} ${run.accountsCreated === 1 ? 'account' : 'accounts'} created`}
                    </span>
                )}
            </div>
            {run.error && <p className="m-0 text-danger">{run.error}</p>}
        </div>
    );
}

/** Where a flagged record lives here, by what it maps to; a link only for the record pages that exist. */
function localPath(workspaceId: string, localType: string, localId: string): string | null {
    switch (localType) {
        case 'company':
            return paths.company(workspaceId, localId);
        case 'person':
            return paths.person(workspaceId, localId);
        case 'opportunity':
            return paths.deal(workspaceId, localId);
        default:
            return null;
    }
}

/**
 * The cutover reconciliation report (#156, D-252): what a reconcile pass flagged as missing in Twenty,
 * per object and record by record, for a person to review. Nothing here is deleted on its own; a run
 * that sees a record in Twenty again clears its flag.
 */
function MissingCard({ workspaceId, latest }: { workspaceId: string; latest: TwentyImportRunView | null }) {
    const missing = useTwentyImportMissing(workspaceId);
    const items = missing.data?.items ?? [];
    const reconciled = latest?.mode === 'reconcile' && isFinalRun(latest) ? latest : null;
    if (items.length === 0 && !reconciled) return null;
    const perObject = TWENTY_IMPORT_OBJECTS.map((object) => ({
        object,
        count: reconciled
            ? (reconciled.report.find((r) => r.object === object)?.missingInSource ?? 0)
            : items.filter((i) => i.object === object).length,
    })).filter((o) => o.count > 0);
    return (
        <section
            aria-label="Missing in Twenty"
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
        >
            <h3 className="m-0 text-[14px] font-semibold text-text">Missing in Twenty</h3>
            <p className="m-0 text-[13px] text-text-muted">
                Records mapped from Twenty that it no longer returns — deleted there, or no longer visible to the key.
                Nothing is deleted here on its own: review each and delete or keep it. A later run that finds the record
                again clears the flag.
            </p>
            {perObject.length > 0 && (
                <p className="m-0 text-[13px] text-text">
                    {perObject
                        .map(
                            (o) =>
                                `${count(o.count)} ${o.count === 1 ? OBJECT_NOUN[o.object].one : OBJECT_NOUN[o.object].many}`,
                        )
                        .join(' · ')}
                </p>
            )}
            {missing.isError ? (
                <p role="alert" className="m-0 text-[13px] text-danger">
                    {failureText(missing.error)}
                </p>
            ) : !missing.data ? (
                <LoadingRegion label="Loading missing records" />
            ) : items.length === 0 ? (
                <p className="m-0 text-[13px] text-text-muted">Nothing is missing.</p>
            ) : (
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
                    {items.map((item) => {
                        const to = localPath(workspaceId, item.localType, item.localId);
                        const name = item.name ?? item.externalId;
                        return (
                            <li key={`${item.object}:${item.externalId}`} className="flex flex-wrap items-center gap-2">
                                {to ? (
                                    <Link
                                        to={to}
                                        className="font-medium hover:underline max-md:min-h-touch max-md:content-center"
                                    >
                                        {name}
                                    </Link>
                                ) : (
                                    <span className="font-medium">{name}</span>
                                )}
                                <span className="text-text-muted">
                                    {label(item.object)} · missing since {formatDate(item.missingSince)}
                                </span>
                            </li>
                        );
                    })}
                    {missing.data.nextCursor && (
                        <li className="text-text-muted">The first 200 are listed; the run report has the counts.</li>
                    )}
                </ul>
            )}
        </section>
    );
}

/** What a run did per object; phone cards keep the name and the two counts that matter most. */
function ReportTable({ report }: { report: TwentyImportObjectReportView[] }) {
    type Row = TwentyImportObjectReportView;
    const rows = TWENTY_IMPORT_OBJECTS.map((object) => report.find((r) => r.object === object)).filter(
        (r): r is Row => r !== undefined,
    );
    const errors = rows.flatMap((r) => r.errors.map((e) => ({ object: r.object, ...e })));
    return (
        <section aria-label="Run report" className="flex flex-col gap-2">
            <DataTableChrome
                data={{
                    label: 'Run report',
                    rows,
                    getRowId: (row: Row) => row.object,
                    columns: [
                        {
                            id: 'object',
                            header: 'Object',
                            className: 'font-medium',
                            cell: (row: Row) => label(row.object),
                        },
                        {
                            id: 'remote',
                            header: 'In Twenty',
                            muted: true,
                            phone: 'meta',
                            cell: (row: Row) => count(row.remote),
                        },
                        {
                            id: 'before',
                            header: 'Before',
                            muted: true,
                            phone: 'hidden',
                            cell: (row: Row) => count(row.before),
                        },
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
                        {
                            id: 'unchanged',
                            header: 'Unchanged',
                            muted: true,
                            phone: 'hidden',
                            cell: (row: Row) => count(row.unchanged),
                        },
                        {
                            id: 'merged',
                            header: 'Merged',
                            muted: true,
                            phone: 'hidden',
                            cell: (row: Row) => count(row.merged),
                        },
                        {
                            id: 'skipped',
                            header: 'Skipped',
                            muted: true,
                            phone: 'hidden',
                            cell: (row: Row) => count(row.skipped),
                        },
                        {
                            id: 'missing',
                            header: 'Missing in Twenty',
                            muted: true,
                            phone: 'hidden',
                            cell: (row: Row) => (row.missingInSource === null ? '—' : count(row.missingInSource)),
                        },
                        {
                            id: 'failed',
                            header: 'Failed',
                            phone: 'meta',
                            cell: (row: Row) =>
                                row.failed > 0 ? (
                                    <span className="text-danger">{count(row.failed)}</span>
                                ) : (
                                    count(row.failed)
                                ),
                        },
                        {
                            id: 'after',
                            header: 'After',
                            muted: true,
                            phone: 'hidden',
                            cell: (row: Row) => count(row.after),
                        },
                    ],
                }}
            />
            {errors.length > 0 && (
                <details className="text-[13px]">
                    <summary className="flex min-h-touch cursor-pointer items-center text-text-muted md:min-h-0">
                        {errors.length} record{errors.length === 1 ? '' : 's'} skipped or refused
                    </summary>
                    <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
                        {errors.map((e, i) => (
                            <li key={`${e.object}-${e.externalId}-${i}`} className="break-all">
                                <span className="text-text-muted">{label(e.object)}</span> {e.externalId}: {e.message}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </section>
    );
}
