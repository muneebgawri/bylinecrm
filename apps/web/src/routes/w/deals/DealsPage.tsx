import { DEFAULT_CURRENCY, ID_FIELD, type ViewColumn, type ViewSort } from '@bylinecrm/shared';
import {
    Badge,
    Button,
    EmptyState,
    Input,
    PageHeader,
    readStored,
    SegmentedControl,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Skeleton,
    toast,
    useCoarsePointer,
    useIsMobile,
    writeStored,
} from '@bylinecrm/ui';
import { Plus, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../../../api/client';
import { opportunities } from '../../../api/endpoints';
import { useViewCounts } from '../../../api/lists';
import { useBoard, useCustomFields, useMembersById, usePipelines, useRules, useViews } from '../../../api/queries';
import type { OpportunityView } from '../../../api/types';
import { useCan, useMembership, usePermission } from '../../../auth/capabilities';
import { useDebounced } from '../../../lib/useDebounced';
import { useKeyedState } from '../../../lib/useKeyedState';
import { saveFile } from '../../../lib/saveFile';
import { useRegisterCommands } from '../../../commands/registry';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { withOpen } from '../records/targets';
import { AssignOwnerDialog, failureText } from '../lists/ListDialogs';
import { allColumns, IDENTITY_FIELD, isSortable, resolveColumns } from '../lists/listConfig';
import { ListToolbar, useFilterFields } from '../lists/ListToolbar';
import { formatSort, useListState } from '../lists/useListState';
import { ViewBar } from '../lists/ViewBar';
import { ruleEventLabel } from './BackwardMoveDialog';
import { DealsBoard } from './DealsBoard';
import { DealsList } from './DealsList';
import { DEALS_PARAMS, DEALS_VIEW_KEY, isDealsView, type DealsView } from './dealsView';
import { MoveSheet } from './MoveSheet';
import { NewDealDialog } from './NewDealDialog';
import { useDealMove } from './useDealMove';

const VIEW_OPTIONS = [
    { value: 'board', label: 'Board' },
    { value: 'list', label: 'List' },
] as const satisfies readonly { value: DealsView; label: string }[];

/** The person's stored choice of rendering; the board when nothing (or nothing valid) is stored. */
const storedView = (): DealsView => readStored<DealsView>(DEALS_VIEW_KEY, isDealsView, 'board');

/**
 * Deals: one query (the pipeline's board under the current sort and search), two renderings.
 * The URL carries pipeline, rendering, sort and search so a shared link opens the same deals
 * the same way; the rendering also persists per person (doc 50 §B).
 */
export function DealsPage() {
    const workspaceId = useWorkspaceId();
    const [params, setParams] = useSearchParams();
    const canRead = useCan('deal:read');
    const canMove = useCan('deal:move');
    const canBulk = useCan('deal:bulk');
    const canEdit = useCan('deal:edit');
    const configure = usePermission('pipeline:configure');
    const canSaveView = usePermission('view:save');
    const canShareView = usePermission('view:share');
    const membership = useMembership();
    // A phone gets one stage per screen and stacked cards; a finger gets "Move to stage" instead of drag.
    const mobile = useIsMobile();
    const coarse = useCoarsePointer();
    const navigate = useNavigate();
    const location = useLocation();
    const [moving, setMoving] = useState<OpportunityView | null>(null);
    const [assigning, setAssigning] = useState<string[] | null>(null);

    const pipelines = usePipelines(workspaceId);
    const pipelineId =
        params.get(DEALS_PARAMS.pipeline) ?? pipelines.data?.find((p) => p.isDefault)?.id ?? pipelines.data?.[0]?.id;
    const pipeline = pipelines.data?.find((p) => p.id === pipelineId);
    const urlRender = params.get(DEALS_PARAMS.render);
    const view: DealsView = isDealsView(urlRender) ? urlRender : storedView();
    const creating = params.get(DEALS_PARAMS.create) !== null;

    // The list state every list shares (P1-UI-6): saved view, inline filter, sort, search — in the
    // URL under the same names, read and written by the same hook as people and companies.
    const { state, update, selectView, encodedFilter } = useListState();
    const views = useViews(workspaceId, 'opportunity');
    const savedView = views.data?.find((v) => v.id === state.viewId);
    const filter = state.filter ?? savedView?.filter ?? null;
    const sorts: ViewSort[] = state.sorts.length ? state.sorts : (savedView?.sorts ?? []);
    const fields = useFilterFields(workspaceId, 'opportunity');
    const members = useMembersById(workspaceId);
    const customFields = useCustomFields(workspaceId, 'opportunity');
    const available = useMemo(() => allColumns('opportunity', customFields.data ?? []), [customFields.data]);
    const [columnsDraft, setColumnsDraft] = useKeyedState<ViewColumn[] | null>(state.viewId ?? '__all__', null);
    const columns = useMemo(
        () => resolveColumns('opportunity', available, columnsDraft ?? savedView?.columns),
        [available, columnsDraft, savedView?.columns],
    );
    const viewColumns: ViewColumn[] = columns.map(({ column, width }) => ({ field: column.field, width }));
    const sortParam = formatSort(state.sorts);
    // Every tab counts its view the way people and companies do — one `limit=1` list read per view,
    // across all pipelines as the view's filter defines it — not from the board, which counts one
    // pipeline. The board's lane counts and sums are its own.
    const tabViews = useMemo(() => [undefined, ...(views.data ?? []).map((v) => v.id)], [views.data]);
    const tabCounts = useViewCounts(workspaceId, 'opportunity', tabViews);

    const board = useBoard(workspaceId, pipelineId, {
        view: state.viewId,
        filter: encodedFilter,
        sort: sortParam,
        q: state.q || undefined,
    });
    const rules = useRules(workspaceId, pipelineId);
    const [announcement, setAnnouncement] = useState('');
    const announce = useCallback((text: string) => setAnnouncement(text), []);
    const move = useDealMove(workspaceId, board.data, announce);

    const setParam = useCallback(
        (key: string, value: string | undefined) =>
            setParams(
                (prev) => {
                    const next = new URLSearchParams(prev);
                    if (value === undefined || value === '') next.delete(key);
                    else next.set(key, value);
                    return next;
                },
                { replace: true },
            ),
        [setParams],
    );

    const setView = useCallback(
        (next: DealsView) => {
            writeStored(DEALS_VIEW_KEY, next);
            setParam(DEALS_PARAMS.render, next);
        },
        [setParam],
    );

    // Search: typed freely, sent once typing pauses (the same rule every list uses).
    const [searchDraft, setSearchDraft] = useState(state.q);
    const settledSearch = useDebounced(searchDraft);
    useEffect(() => {
        if (settledSearch !== state.q) update({ q: settledSearch });
    }, [settledSearch, state.q, update]);

    const sortColumn = (field: string) => {
        if (!isSortable('opportunity', field)) return;
        const head = sorts[0];
        const next: ViewSort[] =
            head?.field === field
                ? head.direction === 'asc'
                    ? [{ field, direction: 'desc' }]
                    : []
                : [{ field, direction: 'asc' }];
        update({ sorts: next });
    };

    const exportColumns = columns.flatMap((c) => c.column.exportFields).join(',');
    /** Exports the deals the page shows, or (with ids) a selection — one request either way (P1-4a). */
    const exportDeals = useCallback(
        async (ids?: readonly string[]) => {
            try {
                const { blob, filename } = ids
                    ? await opportunities.exportSelection(workspaceId, {
                          filter: { and: [{ field: ID_FIELD.name, op: 'in', value: [...ids] }] },
                          sort: sortParam,
                          columns: exportColumns,
                      })
                    : await opportunities.exportCsv(workspaceId, {
                          view: state.viewId,
                          filter: encodedFilter,
                          sort: sortParam,
                          q: state.q || undefined,
                          columns: exportColumns,
                      });
                saveFile(blob, filename ?? 'deals.csv');
            } catch (error) {
                toast({ title: 'The export did not run', description: failureText(error), tone: 'danger' });
            }
        },
        [workspaceId, sortParam, exportColumns, state.viewId, state.q, encodedFilter],
    );

    useRegisterCommands(
        [
            { id: 'deals.view.board', title: 'Deals: show board', group: 'Deals', run: () => setView('board') },
            { id: 'deals.view.list', title: 'Deals: show list', group: 'Deals', run: () => setView('list') },
            {
                id: 'deals.new',
                title: 'New deal',
                group: 'Create',
                shortcut: 'c d',
                when: () => canEdit,
                run: () => setParam(DEALS_PARAMS.create, '1'),
            },
        ],
        [canEdit, setParam, setView],
    );

    if (pipelines.isError) throw pipelines.error;
    if (board.isError && board.error instanceof ApiError && board.error.status !== 404) throw board.error;

    const currency = board.data?.columns.find((c) => c.deals[0])?.deals[0]?.currency ?? DEFAULT_CURRENCY;
    /** The deal's record drawer over this page (P1-UI-3's `?open=`), so the board stays where it was. */
    const openDeal = useCallback(
        (deal: OpportunityView) =>
            navigate({ search: withOpen(location.search, { type: 'opportunity', id: deal.id }) }),
        [location.search, navigate],
    );
    const enabledRules = (rules.data ?? []).filter((r) => r.enabled);
    const stagesById = new Map(pipeline?.stages.map((s) => [s.id, s]) ?? []);
    const dealCount = board.data?.columns.reduce((n, c) => n + c.count, 0);

    return (
        <div className="p-7 max-md:p-4">
            <PageHeader
                title="Deals"
                subtitle={
                    pipeline
                        ? `${pipeline.name} · ${dealCount ?? '…'} deals`
                        : 'Your pipeline, as a board and as a list.'
                }
                actions={
                    <>
                        {pipelines.data && pipelines.data.length > 1 && (
                            <Select
                                value={pipelineId ?? ''}
                                onValueChange={(id) => setParam(DEALS_PARAMS.pipeline, id)}
                            >
                                <SelectTrigger className="w-48" aria-label="Pipeline">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {pipelines.data.map((p) => (
                                        <SelectItem key={p.id} value={p.id}>
                                            {p.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                        <SegmentedControl
                            aria-label="View"
                            value={view}
                            onValueChange={setView}
                            options={VIEW_OPTIONS}
                        />
                        {canEdit && (
                            <Button
                                data-primary-action
                                variant="primary"
                                shape="square"
                                onClick={() => setParam(DEALS_PARAMS.create, '1')}
                            >
                                <Plus aria-hidden /> New deal
                            </Button>
                        )}
                    </>
                }
            />

            {/* The same view bar and toolbar as every list (P1-UI-6). */}
            <div className="mb-3">
                <ViewBar
                    object="opportunity"
                    views={views.data ?? []}
                    viewId={state.viewId}
                    onSelect={selectView}
                    memberId={membership?.memberId ?? null}
                    canSave={canSaveView.allowed}
                    canShare={canShareView.allowed}
                    dirty={state.filter !== null || state.sorts.length > 0 || columnsDraft !== null}
                    current={{ filter, sorts, columns: viewColumns }}
                    workspaceId={workspaceId}
                    onSaved={() => {
                        update({ filter: null, sorts: [] });
                        setColumnsDraft(null);
                    }}
                    phone={mobile}
                    counts={tabCounts}
                />
            </div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
                <Input
                    type="search"
                    value={searchDraft}
                    onChange={(e) => setSearchDraft(e.target.value)}
                    placeholder="Search deals…"
                    aria-label="Search deals"
                    className="h-8.5 w-64 max-md:w-full"
                />
                <ListToolbar
                    object="opportunity"
                    workspaceId={workspaceId}
                    fields={fields}
                    filter={filter}
                    onFilter={(next) => update({ filter: next })}
                    sorts={sorts}
                    onSorts={(next) => update({ sorts: next })}
                    // Columns belong to the list rendering; the board's cards have none.
                    {...(view === 'list'
                        ? {
                              columns: {
                                  shown: columns.map((c) => c.column.field),
                                  all: available.map((c) => ({ field: c.field, label: c.label })),
                                  locked: [IDENTITY_FIELD.opportunity],
                                  onChange: (choice) =>
                                      setColumnsDraft(
                                          choice
                                              .filter((c) => c.visible)
                                              .map((c) => ({
                                                  field: c.field,
                                                  width: columns.find((x) => x.column.field === c.field)?.width,
                                              })),
                                      ),
                              },
                          }
                        : {})}
                    members={members}
                    phone={mobile}
                    onExport={() => exportDeals()}
                />
                {configure.allowed ? (
                    <Button variant="ghost" size="sm" shape="square" asChild className="ml-auto max-md:ml-0">
                        <Link to={paths.settingsPipelines(workspaceId)}>
                            <Settings2 aria-hidden /> Configure pipeline
                        </Link>
                    </Button>
                ) : null}
            </div>
            {enabledRules.length > 0 && (
                <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
                    <Badge status="info">Stage rules</Badge>
                    {enabledRules.map((rule) => (
                        <span key={rule.id}>
                            {ruleEventLabel(rule.event)} →{' '}
                            <b className="font-medium text-text">{stagesById.get(rule.toStageId)?.name ?? '…'}</b>
                        </span>
                    ))}
                    <span className="text-text-faint">· never backward unless asked</span>
                </div>
            )}

            {membership === null ? (
                // The member's standing is not known yet: loading, not a refusal (found in the browser walk).
                <BoardSkeleton stageNames={pipeline?.stages.map((st) => st.name)} />
            ) : !canRead ? (
                <EmptyState
                    title="You cannot see deals"
                    body="Your role has no deal:read capability. Ask a workspace admin."
                />
            ) : pipelines.isPending || (board.isPending && pipelineId) ? (
                <BoardSkeleton stageNames={pipeline?.stages.map((s) => s.name)} />
            ) : !pipeline || !board.data ? (
                <EmptyState
                    title="No pipeline yet"
                    body="A default pipeline is created with the workspace; if it is missing, configure one in Settings."
                />
            ) : view === 'board' ? (
                <DealsBoard
                    board={board.data}
                    canMove={canMove}
                    layout={mobile ? 'pages' : 'lanes'}
                    touch={mobile || coarse}
                    onMove={move.request}
                    onMoveSheet={setMoving}
                    onOpen={openDeal}
                    announce={announce}
                    onShowList={() => setView('list')}
                />
            ) : (
                <DealsList
                    board={board.data}
                    canMove={canMove}
                    canBulk={canBulk}
                    canEdit={canEdit}
                    columns={columns}
                    sorts={sorts}
                    onSortColumn={sortColumn}
                    onMove={move.request}
                    onBulkAssign={setAssigning}
                    onBulkExport={(ids) => void exportDeals(ids)}
                    onOpen={openDeal}
                    onMoveSheet={setMoving}
                    stacked={mobile}
                />
            )}

            {board.data && (
                <p className="mt-4 text-[13px] text-text-muted">
                    {view !== 'board'
                        ? 'Change a stage from its select; select rows for the bulk bar. Open a deal from its name.'
                        : mobile || coarse
                          ? 'Swipe between stages; tap a deal to open it, or “Move to stage” to move it.'
                          : 'Drag a card, or focus it and press Space, ← →, Space. Click or press Enter to open it. A move the server refuses snaps back and says why.'}
                </p>
            )}

            <div aria-live="polite" aria-atomic="true" className="sr-only">
                {announcement}
            </div>
            {move.dialogs}
            <MoveSheet
                deal={moving}
                stages={pipeline?.stages ?? []}
                onClose={() => setMoving(null)}
                onPick={move.request}
            />
            {assigning && (
                <AssignOwnerDialog
                    workspaceId={workspaceId}
                    object="opportunity"
                    ids={assigning}
                    members={members}
                    onOpenChange={(o) => !o && setAssigning(null)}
                    onDone={(summary) => {
                        setAssigning(null);
                        toast(summary);
                    }}
                />
            )}
            <NewDealDialog
                workspaceId={workspaceId}
                pipeline={pipeline}
                open={creating && canEdit}
                onOpenChange={(open) => !open && setParam(DEALS_PARAMS.create, undefined)}
                currency={currency}
            />
        </div>
    );
}

function BoardSkeleton({ stageNames }: { stageNames: string[] | undefined }) {
    const names = stageNames && stageNames.length > 0 ? stageNames : ['', '', '', ''];
    return (
        <div
            className="grid auto-cols-[minmax(260px,1fr)] grid-flow-col gap-4 overflow-hidden"
            aria-busy="true"
            aria-label="Loading deals"
        >
            {names.map((name, i) => (
                <div key={`${name}-${i}`}>
                    {name ? (
                        <div className="px-1 pt-1.5 pb-3 text-sm font-medium">{name}</div>
                    ) : (
                        <Skeleton className="mb-3 h-7 w-28" />
                    )}
                    <Skeleton className="mb-3 h-28" />
                    <Skeleton className="mb-3 h-28" />
                    <Skeleton className="h-28" />
                </div>
            ))}
        </div>
    );
}
