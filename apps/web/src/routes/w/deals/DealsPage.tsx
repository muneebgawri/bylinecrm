import { DEFAULT_CURRENCY, type FilterGroup, type SavedView, type ViewSort } from '@bylinecrm/shared';
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
    writeStored,
} from '@bylinecrm/ui';
import { Plus, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError } from '../../../api/client';
import { useBoard, useMembersSummary, usePipelines, useRules, useUpdateDeal } from '../../../api/queries';
import type { OpportunityView } from '../../../api/types';
import { useCan, useMembership, usePermission } from '../../../auth/capabilities';
import { decodeFilter, encodeFilter } from '../../../lib/filterParam';
import { useRegisterCommands } from '../../../commands/registry';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { ruleEventLabel } from './BackwardMoveDialog';
import { DealsBoard } from './DealsBoard';
import { DealsList } from './DealsList';
import { DEALS_PARAMS, DEALS_VIEW_KEY, isDealsView, type DealsView } from './dealsView';
import { FilterChips } from './FilterChips';
import { NewDealDialog } from './NewDealDialog';
import { useDealMove } from './useDealMove';
import { ViewPicker } from './ViewPicker';

/** How long typing pauses before the search reaches the URL (and so the API). */
const SEARCH_DEBOUNCE_MS = 300;

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
    const canSaveView = useCan('view:save');
    const canShareView = useCan('view:share');
    const membership = useMembership();

    const pipelines = usePipelines(workspaceId);
    const pipelineId =
        params.get(DEALS_PARAMS.pipeline) ?? pipelines.data?.find((p) => p.isDefault)?.id ?? pipelines.data?.[0]?.id;
    const pipeline = pipelines.data?.find((p) => p.id === pipelineId);
    const urlRender = params.get(DEALS_PARAMS.render);
    const view: DealsView = isDealsView(urlRender) ? urlRender : storedView();
    const savedViewId = params.get(DEALS_PARAMS.view) ?? undefined;
    const filterParam = params.get(DEALS_PARAMS.filter) ?? undefined;
    const sort = params.get(DEALS_PARAMS.sort) ?? undefined;
    const q = params.get(DEALS_PARAMS.q) ?? undefined;
    const creating = params.get(DEALS_PARAMS.create) !== null;

    const board = useBoard(workspaceId, pipelineId, { view: savedViewId, filter: filterParam, sort, q });
    const rules = useRules(workspaceId, pipelineId);
    const members = useMembersSummary(workspaceId);
    const updateDeal = useUpdateDeal(workspaceId);
    const [announcement, setAnnouncement] = useState('');
    const announce = useCallback((text: string) => setAnnouncement(text), []);
    const move = useDealMove(workspaceId, board.data, announce);

    const membersById = useMemo(
        () => new Map((members.data ?? []).map((m) => [m.memberId, m.name ?? 'Member'])),
        [members.data],
    );

    // The saved view, its filter and sort, and the inline overrides — the API applies the same rule:
    // an inline filter or sort replaces the view's whole (P1-4).
    const [selectedView, setSelectedView] = useState<SavedView | null>(null);
    const inlineFilter = useMemo(() => decodeFilter(filterParam), [filterParam]);
    const shownFilter: FilterGroup | null =
        inlineFilter ?? (selectedView && selectedView.id === savedViewId ? selectedView.filter : null);
    const currentSorts: ViewSort[] = useMemo(
        () =>
            (sort ?? '')
                .split(',')
                .filter(Boolean)
                .map((part) => {
                    const [field = '', direction] = part.split(':');
                    return { field, direction: direction === 'desc' ? 'desc' : 'asc' };
                }),
        [sort],
    );

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

    const selectView = useCallback(
        (next: SavedView | null) => {
            setSelectedView(next);
            setParams(
                (prev) => {
                    const p = new URLSearchParams(prev);
                    for (const key of [DEALS_PARAMS.view, DEALS_PARAMS.filter, DEALS_PARAMS.sort]) p.delete(key);
                    if (next) p.set(DEALS_PARAMS.view, next.id);
                    return p;
                },
                { replace: true },
            );
        },
        [setParams],
    );
    const setFilter = useCallback(
        (next: FilterGroup | null) => setParam(DEALS_PARAMS.filter, next ? encodeFilter(next) : undefined),
        [setParam],
    );

    // Search: typed locally, written to the URL after a pause.
    const [search, setSearch] = useState(q ?? '');
    useEffect(() => {
        const handle = setTimeout(() => {
            if ((search.trim() || undefined) !== q) setParam(DEALS_PARAMS.q, search.trim() || undefined);
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [q, search, setParam]);

    const onAssign = useCallback(
        (deal: OpportunityView, ownerId: string | null) =>
            updateDeal.mutate(
                { dealId: deal.id, ownerId },
                {
                    onError: (error) =>
                        toast({
                            title: `${deal.name} was not reassigned`,
                            description: error instanceof ApiError ? error.message : 'The server could not be reached.',
                            tone: 'danger',
                        }),
                },
            ),
        [updateDeal],
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
    const enabledRules = (rules.data ?? []).filter((r) => r.enabled);
    const stagesById = new Map(pipeline?.stages.map((s) => [s.id, s]) ?? []);
    const dealCount = board.data?.columns.reduce((n, c) => n + c.count, 0);

    return (
        <div className="p-7">
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
                        <ViewPicker
                            workspaceId={workspaceId}
                            viewId={savedViewId}
                            onSelect={selectView}
                            current={{ filter: shownFilter, sorts: currentSorts }}
                            memberId={membership?.memberId ?? null}
                            canSave={canSaveView}
                            canShare={canShareView}
                        />
                        {canEdit && (
                            <Button variant="primary" shape="square" onClick={() => setParam(DEALS_PARAMS.create, '1')}>
                                <Plus aria-hidden /> New deal
                            </Button>
                        )}
                    </>
                }
            />

            <div className="mb-4 flex flex-wrap items-center gap-3">
                <FilterChips
                    filter={shownFilter}
                    onChange={setFilter}
                    members={members.data ?? []}
                    ownerFilterAllowed={membership?.recordScope !== 'own'}
                    currency={currency}
                />
                <Input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search deals…"
                    aria-label="Search deals"
                    className="h-8.5 w-64"
                />
                {enabledRules.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
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
                {configure.allowed ? (
                    <Button variant="ghost" size="sm" shape="square" className="ml-auto" asChild>
                        <Link to={paths.settingsPipelines(workspaceId)}>
                            <Settings2 aria-hidden /> Configure pipeline
                        </Link>
                    </Button>
                ) : null}
            </div>

            {!canRead ? (
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
                    membersById={membersById}
                    onMove={move.request}
                    announce={announce}
                    onShowList={() => setView('list')}
                />
            ) : (
                <DealsList
                    board={board.data}
                    canMove={canMove}
                    canBulk={canBulk}
                    canEdit={canEdit}
                    members={members.data ?? []}
                    membersById={membersById}
                    sort={sort}
                    onSortChange={(next) => setParam(DEALS_PARAMS.sort, next)}
                    onMove={move.request}
                    onAssign={onAssign}
                />
            )}

            {board.data && (
                <p className="mt-4 text-[13px] text-text-muted">
                    {view === 'board'
                        ? 'Drag a card, or focus it and press Space, ← →, Space. A move the server refuses snaps back and says why.'
                        : 'Change a stage from its select; select rows for the bulk bar. Sorting is the pipeline’s own.'}
                </p>
            )}

            <div aria-live="polite" aria-atomic="true" className="sr-only">
                {announcement}
            </div>
            {move.dialogs}
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
