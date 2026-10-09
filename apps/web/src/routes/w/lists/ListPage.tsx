import { LIST_LIMIT_DEFAULT, type SavedView, type ViewColumn, type ViewSort } from '@bylinecrm/shared';
import {
    BulkBar,
    BulkBarAction,
    Button,
    cn,
    DataTableChrome,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    EmptyState,
    focusRing,
    PageHeader,
    Skeleton,
    toast,
    useIsMobile,
} from '@bylinecrm/ui';
import { Popover, PopoverContent, PopoverTrigger } from '@bylinecrm/ui/popover';
import { Building2, Columns3, Download, Filter, ListFilter, Plus, Search, Upload, Users } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
    useCreateView,
    useCustomFields,
    useDeleteView,
    useMembersById,
    useUpdateView,
    useViews,
} from '../../../api/queries';
import { useBulkChange, useRecordNames, useRecordPages } from '../../../api/lists';
import { companies as companiesApi, people as peopleApi } from '../../../api/endpoints';
import { useMembership, usePermission } from '../../../auth/capabilities';
import { ResponsivePanel } from '../../../components/ResponsivePanel';
import {
    conditionCount,
    draftProblem,
    filterableFields,
    fromFilter,
    toFilter,
    type DraftGroup,
} from '../../../lib/filterModel';
import { useDebounced } from '../../../lib/useDebounced';
import { useKeyedState } from '../../../lib/useKeyedState';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { withOpen } from '../records/targets';
import { ListCards } from './ListCards';
import {
    AssignOwnerDialog,
    bulkSummary,
    ConfirmDialog,
    CreateRecordDialog,
    failureText,
    SaveViewDialog,
} from './ListDialogs';
import { ColumnChooser, SortEditor, type ColumnChoice } from './ListEditors';
import {
    allColumns,
    IDENTITY_FIELD,
    isSortable,
    LIST_COPY,
    resolveColumns,
    type ListObject,
    type ListRow,
} from './listConfig';
import { ListTable } from './ListTable';
import { formatSort, useListState } from './useListState';

const FilterBuilder = lazy(() => import('./FilterBuilder'));

/** Rows per request: a screenful and a half on a phone, enough to scroll on a desktop. */
const PAGE_SIZE = { phone: 25, desktop: LIST_LIMIT_DEFAULT * 2 } as const;
/** The "All" tab — no saved view. */
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
    const fields = useMemo(() => filterableFields(object, definitions), [object, definitions]);
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

    // Names for the ids rows carry; looked up for the rows on screen only.
    const [visible, setVisible] = useState<string[]>([]);
    const nameIds = useMemo(() => {
        if (object !== 'person') return [];
        const shown = phone ? rows : rows.filter((r) => visible.includes(r.id));
        return shown.flatMap((r) =>
            (r as ListRow<'person'>).companyId ? [(r as ListRow<'person'>).companyId as string] : [],
        );
    }, [object, phone, rows, visible]);
    const companyNames = useRecordNames(workspaceId, 'company', nameIds);
    const context = useMemo(() => ({ members, companies: companyNames }), [members, companyNames]);

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
        const result = await bulk.mutateAsync({ ids, patch: 'delete' });
        setDeleting(null);
        clearSelection();
        toast(bulkSummary('Deleted', ids.length === 1 ? copy.singular : copy.plural, result));
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
            columns={columns.map((c) => c.column.field)}
            allColumns={available.map((c) => ({ field: c.field, label: c.label }))}
            onColumns={(choice) =>
                setColumnsDraft(
                    choice
                        .filter((c) => c.visible)
                        .map((c) => ({
                            field: c.field,
                            width: columns.find((x) => x.column.field === c.field)?.width,
                        })),
                )
            }
            members={members}
            phone={phone}
            onExport={async () => {
                const api = object === 'person' ? peopleApi : companiesApi;
                try {
                    const { blob, filename } = await api.exportCsv(workspaceId, {
                        view: state.viewId,
                        filter: encodedFilter,
                        sort: formatSort(state.sorts),
                        q: state.q || undefined,
                        columns: columns.flatMap((c) => c.column.exportFields).join(','),
                    });
                    saveFile(blob, filename ?? `${copy.plural}.csv`);
                } catch (error) {
                    toast({ title: 'The export did not run', description: failureText(error), tone: 'danger' });
                }
            }}
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
            />

            {phone ? (
                <>
                    <div className="flex flex-col gap-2">
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
                            context={context}
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
                                {rows.length.toLocaleString()} shown
                                {pages.hasNextPage ? ' · more as you scroll' : rows.length ? ' · all loaded' : ''}
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
                            context={context}
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
                            onVisible={setVisible}
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
                    <BulkBarAction disabled title="Sequences arrive in Phase 3.">
                        Enrol in sequence
                    </BulkBarAction>
                    <BulkBarAction
                        disabled={!write.allowed}
                        title={write.reason || undefined}
                        onClick={() => setAssigning([...selected])}
                    >
                        Assign owner
                    </BulkBarAction>
                    <BulkBarAction
                        disabled={!write.allowed}
                        title={write.reason || undefined}
                        onClick={() => setDeleting([...selected])}
                    >
                        Delete
                    </BulkBarAction>
                </BulkBar>
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

/** The browser saves a file the page already holds; a temporary link, clicked once. */
function saveFile(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
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
            <div aria-busy="true" className="flex flex-col gap-2 p-3">
                {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                ))}
            </div>
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

function ListToolbar({
    object,
    workspaceId,
    fields,
    filter,
    onFilter,
    sorts,
    onSorts,
    columns,
    allColumns: every,
    onColumns,
    members,
    phone,
    onExport,
}: {
    object: ListObject;
    workspaceId: string;
    fields: ReturnType<typeof filterableFields>;
    filter: SavedView['filter'];
    onFilter: (next: SavedView['filter']) => void;
    sorts: ViewSort[];
    onSorts: (next: ViewSort[]) => void;
    columns: readonly string[];
    allColumns: readonly { field: string; label: string }[];
    onColumns: (next: ColumnChoice[]) => void;
    members: ReadonlyMap<string, string>;
    phone: boolean;
    onExport: () => Promise<void>;
}) {
    const [filterOpen, setFilterOpen] = useState(false);
    const [draft, setDraft] = useState<DraftGroup>(() => fromFilter(filter));
    const [sortOpen, setSortOpen] = useState(false);
    const [sortDraft, setSortDraft] = useState<ViewSort[]>(sorts);
    const [exporting, setExporting] = useState(false);
    const count = conditionCount(filter);
    const problem = draftProblem(draft);
    const choices: ColumnChoice[] = [
        ...columns.flatMap((field) => {
            const c = every.find((x) => x.field === field);
            return c ? [{ ...c, visible: true, locked: field === IDENTITY_FIELD[object] }] : [];
        }),
        ...every.filter((c) => !columns.includes(c.field)).map((c) => ({ ...c, visible: false, locked: false })),
    ];

    return (
        <>
            <ResponsivePanel
                title={`Filter ${LIST_COPY[object].plural}`}
                open={filterOpen}
                onOpenChange={(o) => {
                    if (o) setDraft(fromFilter(filter));
                    setFilterOpen(o);
                }}
                trigger={
                    <Button size="sm" shape="square" variant={count ? 'accent' : 'secondary'}>
                        <Filter aria-hidden /> Filter{count ? ` · ${count}` : ''}
                    </Button>
                }
                footer={
                    <>
                        <Button
                            shape="square"
                            className="max-md:flex-1"
                            onClick={() => {
                                onFilter(null);
                                setFilterOpen(false);
                            }}
                        >
                            Clear
                        </Button>
                        <Button
                            shape="square"
                            variant="primary"
                            className="max-md:flex-1"
                            disabled={problem !== null}
                            title={problem ?? undefined}
                            onClick={() => {
                                onFilter(toFilter(draft));
                                setFilterOpen(false);
                            }}
                        >
                            {phone ? 'Show results' : 'Apply'}
                        </Button>
                    </>
                }
            >
                <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                    <FilterBuilder
                        workspaceId={workspaceId}
                        fields={fields}
                        value={draft}
                        onChange={setDraft}
                        members={members}
                    />
                </Suspense>
                {problem && (
                    <p role="alert" className="m-0 text-sm text-danger">
                        {problem}
                    </p>
                )}
            </ResponsivePanel>

            <ResponsivePanel
                title={`Sort ${LIST_COPY[object].plural}`}
                open={sortOpen}
                onOpenChange={(o) => {
                    if (o) setSortDraft(sorts);
                    setSortOpen(o);
                }}
                widthClass="w-[min(28rem,calc(100vw-2rem))]"
                trigger={
                    <Button size="sm" shape="square">
                        <ListFilter aria-hidden /> Sort{sorts.length ? ` · ${sorts.length}` : ''}
                    </Button>
                }
                footer={
                    <Button
                        shape="square"
                        variant="primary"
                        className="max-md:flex-1"
                        onClick={() => {
                            onSorts(sortDraft);
                            setSortOpen(false);
                        }}
                    >
                        Apply
                    </Button>
                }
            >
                <SortEditor fields={fields} value={sortDraft} onChange={setSortDraft} />
            </ResponsivePanel>

            {!phone && (
                <Popover>
                    <PopoverTrigger asChild>
                        <Button size="sm" shape="square">
                            <Columns3 aria-hidden /> Columns
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent aria-label="Columns" className="w-72">
                        <ColumnChooser choices={choices} onChange={onColumns} />
                    </PopoverContent>
                </Popover>
            )}

            <Button
                size="sm"
                shape="square"
                loading={exporting}
                onClick={() => {
                    setExporting(true);
                    void onExport().finally(() => setExporting(false));
                }}
            >
                <Download aria-hidden /> Export
            </Button>
        </>
    );
}

/** Saved views: tabs on a desktop, a scrolling chip row on a phone, and the menu that saves them. */
function ViewBar({
    object,
    views,
    viewId,
    onSelect,
    memberId,
    canSave,
    canShare,
    dirty,
    current,
    workspaceId,
    onSaved,
    phone,
}: {
    object: ListObject;
    views: readonly SavedView[];
    viewId: string | undefined;
    onSelect: (id: string | undefined) => void;
    memberId: string | null;
    canSave: boolean;
    canShare: boolean;
    dirty: boolean;
    current: Pick<SavedView, 'filter' | 'sorts' | 'columns'>;
    workspaceId: string;
    onSaved: () => void;
    phone: boolean;
}) {
    const create = useCreateView(workspaceId);
    const updateView = useUpdateView(workspaceId, object);
    const removeView = useDeleteView(workspaceId, object);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const selected = views.find((v) => v.id === viewId);
    const mine = (v: SavedView) => v.ownerMemberId !== null && v.ownerMemberId === memberId;
    const mayChange = (v: SavedView) => (v.isShared ? canShare : mine(v) && canSave);
    const tabs = [
        { id: ALL, label: `All ${LIST_COPY[object].plural}` },
        ...views.map((v) => ({ id: v.id, label: v.name })),
    ];

    return (
        <div className="flex items-center gap-2">
            <div role="tablist" aria-label="Views" className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5">
                {tabs.map((tab) => {
                    const active = (tab.id === ALL && !viewId) || tab.id === viewId;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => onSelect(tab.id === ALL ? undefined : tab.id)}
                            className={cn(
                                'h-8 shrink-0 rounded-md border border-transparent px-3 text-sm font-medium whitespace-nowrap text-text-muted max-md:h-touch max-md:rounded-full max-md:border-border max-md:bg-surface',
                                active &&
                                    'border-border bg-surface text-text shadow-sm max-md:border-accent max-md:bg-accent-soft max-md:text-accent',
                                focusRing,
                            )}
                        >
                            {tab.label}
                        </button>
                    );
                })}
            </div>
            {(canSave || (selected && mayChange(selected))) && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="sm" shape="square" variant={dirty ? 'accent' : 'secondary'}>
                            {phone ? 'View' : dirty ? 'Save changes' : 'View'}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        {selected && mayChange(selected) && (
                            <DropdownMenuItem
                                disabled={!dirty}
                                onSelect={() =>
                                    void updateView
                                        .mutateAsync({ viewId: selected.id, ...current })
                                        .then(() => {
                                            onSaved();
                                            toast({ title: `Saved “${selected.name}”`, tone: 'success' });
                                        })
                                        .catch((e: unknown) =>
                                            toast({
                                                title: 'The view was not saved',
                                                description: failureText(e),
                                                tone: 'danger',
                                            }),
                                        )
                                }
                            >
                                Update “{selected.name}”
                            </DropdownMenuItem>
                        )}
                        {canSave && (
                            <DropdownMenuItem
                                onSelect={() => {
                                    setSaveError(null);
                                    setSaving(true);
                                }}
                            >
                                Save as new view…
                            </DropdownMenuItem>
                        )}
                        {selected && canShare && mine(selected) && (
                            <DropdownMenuItem
                                onSelect={() =>
                                    void updateView
                                        .mutateAsync({ viewId: selected.id, isShared: !selected.isShared })
                                        .then(() =>
                                            toast({
                                                title: selected.isShared
                                                    ? 'Only you see this view now'
                                                    : 'Shared with the workspace',
                                                tone: 'success',
                                            }),
                                        )
                                        .catch((e: unknown) =>
                                            toast({
                                                title: 'Sharing did not change',
                                                description: failureText(e),
                                                tone: 'danger',
                                            }),
                                        )
                                }
                            >
                                {selected.isShared ? 'Stop sharing' : 'Share with the workspace'}
                            </DropdownMenuItem>
                        )}
                        {selected && mayChange(selected) && (
                            <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className="text-danger" onSelect={() => setConfirmDelete(true)}>
                                    Delete view…
                                </DropdownMenuItem>
                            </>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            {saving && (
                <SaveViewDialog
                    open
                    onOpenChange={(o) => !o && setSaving(false)}
                    canShare={canShare}
                    pending={create.isPending}
                    error={saveError}
                    onSave={(name, isShared) =>
                        void create
                            .mutateAsync({ object, name, isShared, ...current })
                            .then((created) => {
                                setSaving(false);
                                onSaved();
                                onSelect(created.id);
                                toast({ title: `Saved “${created.name}”`, tone: 'success' });
                            })
                            .catch((e: unknown) => setSaveError(failureText(e)))
                    }
                />
            )}
            <ConfirmDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                title={`Delete “${selected?.name ?? ''}”?`}
                body={
                    selected?.isShared
                        ? 'Everyone in the workspace loses this view.'
                        : 'Only the view goes; no records change.'
                }
                confirm="Delete view"
                pending={removeView.isPending}
                onConfirm={() =>
                    selected &&
                    void removeView.mutateAsync(selected.id).then(() => {
                        setConfirmDelete(false);
                        onSelect(undefined);
                    })
                }
            />
        </div>
    );
}
