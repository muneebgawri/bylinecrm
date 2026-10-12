import { ID_FIELD, LIST_LIMIT_DEFAULT, SEQUENCE_LIMITS, type ViewColumn, type ViewSort } from '@bylinecrm/shared';
import {
    BulkBar,
    BulkBarAction,
    Button,
    cn,
    DataTableChrome,
    EmptyState,
    LoadingRegion,
    PageHeader,
    Skeleton,
    toast,
    useIsMobile,
} from '@bylinecrm/ui';
import { Building2, Plus, Search, Upload, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useCustomFields, useMembersById, useViews } from '../../../api/records';
import { useBulkChange, useRecordPages, useViewCounts, type ListCount } from '../../../api/lists';
import { companies as companiesApi, people as peopleApi } from '../../../api/records';
import { useMembership, usePermission } from '../../../auth/capabilities';
import { useDebounced } from '../../../lib/useDebounced';
import { useKeyedState } from '../../../lib/useKeyedState';
import { saveFile } from '../../../lib/saveFile';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { withOpen } from '../records/targets';
import { EnrolDialog, enrolSummary, type EnrolPerson } from '../sequences/EnrolDialog';
import { ListCards } from './ListCards';
import { AssignOwnerDialog, bulkSummary, ConfirmDialog, CreateRecordDialog, failureText } from './ListDialogs';
import {
    allColumns,
    IDENTITY_FIELD,
    isSortable,
    LIST_COPY,
    personName,
    resolveColumns,
    type ListObject,
    type ListRow,
} from './listConfig';
import { ListTable } from './ListTable';
import { ListToolbar, useFilterFields } from './ListToolbar';
import { formatSort, useListState } from './useListState';
import { formatCount, ViewBar } from './ViewBar';

/** Rows per request: a screenful and a half on a phone, enough to scroll on a desktop. */
const PAGE_SIZE = { phone: 25, desktop: LIST_LIMIT_DEFAULT * 2 } as const;
/** The "All" tab — no saved view — in a key built from the view id. */
const ALL = '__all__';
const NOTHING_SELECTED: ReadonlySet<string> = new Set();

export function PeopleListPage() {
    return <RecordListPage object="person" />;
}

export function CompaniesListPage() {
    return <RecordListPage object="company" />;
}

/**
 * A data view (FR-CRMS-UI-1, FR-CRMS-UI-12): saved views as tabs, search, a filter builder, sort,
 * a column chooser, export, row and bulk actions — a table on a desktop, stacked cards on a
 * phone, over one query whose state is in the URL.
 */
function RecordListPage<O extends ListObject>({ object }: { object: O }) {
    const workspaceId = useWorkspaceId();
    const phone = useIsMobile();
    const navigate = useNavigate();
    const location = useLocation();
    const copy = LIST_COPY[object];
    const membership = useMembership();
    const write = usePermission('record:write');
    const saveViews = usePermission('view:save');
    const shareViews = usePermission('view:share');

    const { state, update, selectView, encodedFilter } = useListState();
    const views = useViews(workspaceId, object);
    const view = views.data?.find((v) => v.id === state.viewId);
    const customFields = useCustomFields(workspaceId, object);
    const definitions = useMemo(() => customFields.data ?? [], [customFields.data]);
    const fields = useFilterFields(workspaceId, object);
    const members = useMembersById(workspaceId);

    const filter = state.filter ?? view?.filter ?? null;
    const sorts: ViewSort[] = state.sorts.length ? state.sorts : (view?.sorts ?? []);

    // Column changes apply at once and are kept until the view is saved or another is chosen.
    const [columnsDraft, setColumnsDraft] = useKeyedState<ViewColumn[] | null>(state.viewId ?? ALL, null);
    const available = useMemo(() => allColumns(object, definitions), [object, definitions]);
    const columns = useMemo(
        () => resolveColumns(object, available, columnsDraft ?? view?.columns),
        [object, available, columnsDraft, view?.columns],
    );
    const viewColumns: ViewColumn[] = columns.map(({ column, width }) => ({ field: column.field, width }));

    // Search: typed freely, sent once typing pauses.
    const [searchDraft, setSearchDraft] = useState(state.q);
    const settledSearch = useDebounced(searchDraft);
    useEffect(() => {
        if (settledSearch !== state.q) update({ q: settledSearch });
    }, [settledSearch, state.q, update]);

    const query = {
        view: state.viewId,
        filter: encodedFilter,
        sort: formatSort(state.sorts),
        q: state.q || undefined,
        limit: phone ? PAGE_SIZE.phone : PAGE_SIZE.desktop,
    };
    const pages = useRecordPages(workspaceId, object, query);
    const rows = useMemo(() => (pages.data?.pages ?? []).flatMap((p) => p.items) as ListRow<O>[], [pages.data]);
    const firstPage = pages.data?.pages[0];
    const total = useMemo<ListCount | undefined>(
        () => (firstPage ? { total: firstPage.total, exact: firstPage.totalIsExact } : undefined),
        [firstPage],
    );
    const loadedPages = pages.data?.pages.length ?? 0;
    const pageSize = query.limit;

    // The tabs' counts: each saved view's from a one-row read; the open one's from this page's own query.
    const tabViews = useMemo(
        () => [undefined, ...(views.data ?? []).map((v) => v.id)].filter((v) => v !== state.viewId),
        [views.data, state.viewId],
    );
    const otherCounts = useViewCounts(workspaceId, object, tabViews);
    const tabCounts = useMemo(() => {
        const counts = new Map(otherCounts);
        // An inline filter or search changes what the open tab holds; its count is then the page's.
        if (total) counts.set(state.viewId, total);
        return counts;
    }, [otherCounts, total, state.viewId]);

    // Selection.
    const [selected, setSelected] = useKeyedState<ReadonlySet<string>>(
        `${state.viewId ?? ALL}|${encodedFilter ?? ''}|${state.q}`,
        NOTHING_SELECTED,
    );
    const [selecting, setSelecting] = useState(false);
    const toggle = (id: string) =>
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    const clearSelection = () => {
        setSelected(new Set());
        setSelecting(false);
    };

    const [assigning, setAssigning] = useState<string[] | null>(null);
    const enrol = usePermission('sequence:enrol');
    const [enrolling, setEnrolling] = useState<EnrolPerson[] | null>(null);
    const [deleting, setDeleting] = useState<string[] | null>(null);
    const [creating, setCreating] = useState(false);
    const bulk = useBulkChange(workspaceId, object);

    const open = useCallback(
        (row: ListRow<O>, fullPage: boolean) => {
            if (fullPage || phone) {
                const path =
                    object === 'person' ? paths.person(workspaceId, row.id) : paths.company(workspaceId, row.id);
                navigate(path, { state: { list: { ids: rows.map((r) => r.id) } } });
            } else {
                navigate({
                    pathname: location.pathname,
                    search: withOpen(location.search, { type: object, id: row.id }),
                });
            }
        },
        [phone, object, workspaceId, navigate, rows, location.pathname, location.search],
    );

    const sortColumn = (field: string) => {
        if (!isSortable(object, field)) return;
        const head = sorts[0];
        const next: ViewSort[] =
            head?.field === field
                ? head.direction === 'asc'
                    ? [{ field, direction: 'desc' }]
                    : []
                : [{ field, direction: 'asc' }];
        update({ sorts: next });
    };

    const filtered = filter !== null || state.q !== '';
    const loading = pages.isPending;
    const empty = !loading && !pages.isError && rows.length === 0;

    const removeIds = async (ids: string[]) => {
        try {
            const result = await bulk.mutateAsync({ action: 'delete', ids });
            toast(bulkSummary('Deleted', copy, result));
        } catch (error) {
            toast({ title: 'Nothing was deleted', description: failureText(error), tone: 'danger' });
        }
        setDeleting(null);
        clearSelection();
    };

    const api = object === 'person' ? peopleApi : companiesApi;
    const exportColumns = columns.flatMap((c) => c.column.exportFields).join(',');
    /** Exports what the list shows, or (with ids) the selection — one request either way. */
    const exportRows = async (ids?: readonly string[]) => {
        try {
            const { blob, filename } = ids
                ? await api.exportSelection(workspaceId, {
                      filter: { and: [{ field: ID_FIELD.name, op: 'in', value: [...ids] }] },
                      sort: formatSort(state.sorts),
                      columns: exportColumns,
                  })
                : await api.exportCsv(workspaceId, {
                      view: state.viewId,
                      filter: encodedFilter,
                      sort: formatSort(state.sorts),
                      q: state.q || undefined,
                      columns: exportColumns,
                  });
            saveFile(blob, filename ?? `${copy.plural}.csv`);
        } catch (error) {
            toast({ title: 'The export did not run', description: failureText(error), tone: 'danger' });
        }
    };

    const toolbar = (
        <ListToolbar
            object={object}
            workspaceId={workspaceId}
            fields={fields}
            filter={filter}
            onFilter={(next) => update({ filter: next })}
            sorts={sorts}
            onSorts={(next) => update({ sorts: next })}
            columns={{
                shown: columns.map((c) => c.column.field),
                all: available.map((c) => ({ field: c.field, label: c.label })),
                locked: [IDENTITY_FIELD[object]],
                onChange: (choice) =>
                    setColumnsDraft(
                        choice
                            .filter((c) => c.visible)
                            .map((c) => ({
                                field: c.field,
                                width: columns.find((x) => x.column.field === c.field)?.width,
                            })),
                    ),
            }}
            members={members}
            phone={phone}
            onExport={() => exportRows()}
        />
    );

    return (
        <div className={cn('flex flex-col gap-4 p-7 max-md:p-4', (selected.size > 0 || selecting) && 'max-md:pb-28')}>
            <PageHeader
                title={copy.title}
                subtitle={copy.subtitle}
                actions={
                    <>
                        <Button
                            shape="square"
                            disabled
                            title="Importing a list arrives with the importer (P4-4)."
                            className="max-md:hidden"
                        >
                            <Upload aria-hidden /> Import
                        </Button>
                        {write.allowed && (
                            <Button
                                data-primary-action
                                data-primary-dialog
                                shape="square"
                                variant="primary"
                                onClick={() => setCreating(true)}
                            >
                                <Plus aria-hidden /> {copy.add}
                            </Button>
                        )}
                    </>
                }
            />

            <ViewBar
                object={object}
                views={views.data ?? []}
                viewId={state.viewId}
                onSelect={selectView}
                memberId={membership?.memberId ?? null}
                canSave={saveViews.allowed}
                canShare={shareViews.allowed}
                dirty={state.filter !== null || state.sorts.length > 0 || columnsDraft !== null}
                current={{ filter, sorts, columns: viewColumns }}
                workspaceId={workspaceId}
                onSaved={() => {
                    update({ filter: null, sorts: [] });
                    setColumnsDraft(null);
                }}
                phone={phone}
                counts={tabCounts}
            />

            {phone ? (
                <>
                    <div className="flex flex-col gap-2">
                        {total && (
                            <p className="m-0 text-sm text-text-muted" aria-live="polite">
                                {formatCount(total)} {total.total === 1 ? copy.singular : copy.plural}
                            </p>
                        )}
                        <label className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 focus-within:ring-2 focus-within:ring-ring">
                            <Search aria-hidden className="size-4 shrink-0 text-text-faint" />
                            <input
                                type="search"
                                value={searchDraft}
                                onChange={(e) => setSearchDraft(e.target.value)}
                                placeholder={copy.search}
                                aria-label={copy.search}
                                className="min-h-touch w-full bg-transparent text-touch text-text outline-none placeholder:text-text-faint"
                            />
                        </label>
                        <div className="flex flex-wrap gap-2">
                            {toolbar}
                            <Button
                                shape="square"
                                size="sm"
                                onClick={() => (selecting ? clearSelection() : setSelecting(true))}
                            >
                                {selecting ? 'Done' : 'Select'}
                            </Button>
                        </div>
                    </div>
                    <ListBody
                        loading={loading}
                        error={pages.isError ? failureText(pages.error) : null}
                        onRetry={() => void pages.refetch()}
                        empty={empty}
                        filtered={filtered}
                        object={object}
                        onClear={() => {
                            setSearchDraft('');
                            update({ filter: null, q: '' });
                            selectView(undefined);
                        }}
                        onAdd={write.allowed ? () => setCreating(true) : undefined}
                    >
                        <ListCards
                            object={object}
                            rows={rows}
                            selecting={selecting}
                            selected={selected}
                            onToggle={toggle}
                            onStartSelecting={(id) => {
                                setSelecting(true);
                                toggle(id);
                            }}
                            onOpen={(row) => open(row, true)}
                            hasMore={pages.hasNextPage}
                            loadingMore={pages.isFetchingNextPage}
                            onMore={() => void pages.fetchNextPage()}
                        />
                    </ListBody>
                </>
            ) : (
                <DataTableChrome
                    search={{ value: searchDraft, onChange: setSearchDraft, placeholder: copy.search }}
                    toolbar={{ extra: toolbar }}
                    footer={
                        <>
                            <span>
                                {total ? (
                                    <>
                                        Page {Math.max(loadedPages, 1)} of{' '}
                                        {total.exact
                                            ? Math.max(Math.ceil(total.total / pageSize), 1).toLocaleString()
                                            : `${Math.ceil(total.total / pageSize).toLocaleString()}+`}{' '}
                                        · {rows.length.toLocaleString()} of {formatCount(total)} {copy.plural}
                                    </>
                                ) : (
                                    `${rows.length.toLocaleString()} shown`
                                )}
                            </span>
                            {selected.size > 0 && <span>{selected.size} selected</span>}
                            {pages.isFetchingNextPage && <span>Loading more…</span>}
                            <span className="ml-auto text-text-faint">
                                Click opens the panel · ⌘/Ctrl-click the full page
                            </span>
                        </>
                    }
                >
                    <ListBody
                        loading={loading}
                        error={pages.isError ? failureText(pages.error) : null}
                        onRetry={() => void pages.refetch()}
                        empty={empty}
                        filtered={filtered}
                        object={object}
                        onClear={() => {
                            setSearchDraft('');
                            update({ filter: null, q: '' });
                            selectView(undefined);
                        }}
                        onAdd={write.allowed ? () => setCreating(true) : undefined}
                    >
                        <ListTable
                            object={object}
                            rows={rows}
                            columns={columns}
                            sorts={sorts}
                            onSortColumn={sortColumn}
                            selected={selected}
                            onToggle={toggle}
                            onToggleAll={() =>
                                setSelected((current) =>
                                    rows.every((r) => current.has(r.id)) ? new Set() : new Set(rows.map((r) => r.id)),
                                )
                            }
                            onOpen={open}
                            onResize={(field, width) =>
                                setColumnsDraft(viewColumns.map((c) => (c.field === field ? { ...c, width } : c)))
                            }
                            hasMore={pages.hasNextPage}
                            loadingMore={pages.isFetchingNextPage}
                            onMore={() => void pages.fetchNextPage()}
                            canWrite={write.allowed}
                            writeReason={write.reason}
                            onAssign={setAssigning}
                            onDelete={setDeleting}
                        />
                    </ListBody>
                </DataTableChrome>
            )}

            {selected.size > 0 && (
                <BulkBar
                    count={selected.size}
                    onDiscard={clearSelection}
                    discardLabel="Clear"
                    className="max-md:fixed max-md:inset-x-3 max-md:bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-md:z-30 max-md:mx-0 max-md:w-auto max-md:flex-wrap max-md:justify-center"
                >
                    {object === 'person' && (
                        <BulkBarAction
                            disabled={!enrol.allowed || selected.size > SEQUENCE_LIMITS.enrolBatch}
                            title={
                                enrol.reason ||
                                (selected.size > SEQUENCE_LIMITS.enrolBatch
                                    ? `At most ${SEQUENCE_LIMITS.enrolBatch} people at a time.`
                                    : undefined)
                            }
                            onClick={() =>
                                setEnrolling(
                                    (rows as ListRow<'person'>[])
                                        .filter((r) => selected.has(r.id))
                                        .map((r) => ({ id: r.id, name: personName(r), email: r.emails.primary })),
                                )
                            }
                        >
                            Enrol in sequence
                        </BulkBarAction>
                    )}
                    <BulkBarAction
                        disabled={!write.allowed}
                        title={write.reason || undefined}
                        onClick={() => setAssigning([...selected])}
                    >
                        Assign owner
                    </BulkBarAction>
                    <BulkBarAction onClick={() => void exportRows([...selected])}>Export selected</BulkBarAction>
                    <BulkBarAction
                        disabled={!write.allowed}
                        title={write.reason || undefined}
                        onClick={() => setDeleting([...selected])}
                    >
                        Delete
                    </BulkBarAction>
                </BulkBar>
            )}

            {enrolling && (
                <EnrolDialog
                    workspaceId={workspaceId}
                    people={enrolling}
                    onOpenChange={(o) => !o && setEnrolling(null)}
                    onDone={(result) => {
                        setEnrolling(null);
                        clearSelection();
                        toast({ title: enrolSummary(result) });
                    }}
                />
            )}
            {assigning && (
                <AssignOwnerDialog
                    workspaceId={workspaceId}
                    object={object}
                    ids={assigning}
                    members={members}
                    onOpenChange={(o) => !o && setAssigning(null)}
                    onDone={(summary) => {
                        setAssigning(null);
                        clearSelection();
                        toast(summary);
                    }}
                />
            )}
            <ConfirmDialog
                open={deleting !== null}
                onOpenChange={(o) => !o && setDeleting(null)}
                title={
                    deleting?.length === 1
                        ? `Delete this ${copy.singular}?`
                        : `Delete ${deleting?.length ?? 0} ${copy.plural}?`
                }
                body="They move to the trash and can be restored from there."
                confirm="Delete"
                pending={bulk.isPending}
                onConfirm={() => deleting && void removeIds(deleting)}
            />
            {creating && (
                <CreateRecordDialog
                    workspaceId={workspaceId}
                    object={object}
                    onOpenChange={(o) => !o && setCreating(false)}
                    onCreated={(id) => {
                        setCreating(false);
                        navigate({
                            pathname: location.pathname,
                            search: withOpen(location.search, { type: object, id }),
                        });
                    }}
                />
            )}
        </div>
    );
}

function ListBody({
    loading,
    error,
    onRetry,
    empty,
    filtered,
    object,
    onClear,
    onAdd,
    children,
}: {
    loading: boolean;
    error: string | null;
    onRetry: () => void;
    empty: boolean;
    filtered: boolean;
    object: ListObject;
    onClear: () => void;
    onAdd: (() => void) | undefined;
    children: React.ReactNode;
}) {
    const copy = LIST_COPY[object];
    const Icon = object === 'person' ? Users : Building2;
    if (loading) {
        return (
            <LoadingRegion label={`Loading ${copy.plural.toLowerCase()}`} className="flex flex-col gap-2 p-3">
                {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                ))}
            </LoadingRegion>
        );
    }
    if (error) {
        return (
            <EmptyState
                icon={<Icon />}
                title={`Couldn't load ${copy.plural}`}
                body={error}
                action={
                    <Button shape="square" onClick={onRetry}>
                        Retry
                    </Button>
                }
            />
        );
    }
    if (empty) {
        return filtered ? (
            <EmptyState
                icon={<Icon />}
                title={`No ${copy.plural} match this view`}
                body="Change the filter or search, or clear them to see everything."
                action={
                    <Button shape="square" onClick={onClear}>
                        Clear filters
                    </Button>
                }
            />
        ) : (
            <EmptyState
                icon={<Icon />}
                title={`No ${copy.plural} yet`}
                body={
                    object === 'person'
                        ? 'Add a person, or import a list; every address is verified before any sequence can reach it.'
                        : 'A company is created from a person’s work domain or added by hand.'
                }
                action={
                    onAdd ? (
                        <Button shape="square" variant="primary" onClick={onAdd}>
                            <Plus aria-hidden /> {copy.add}
                        </Button>
                    ) : undefined
                }
            />
        );
    }
    return <>{children}</>;
}
