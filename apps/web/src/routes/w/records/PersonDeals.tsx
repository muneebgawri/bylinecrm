import { DEFAULT_CURRENCY } from '@bylinecrm/shared';
import { Button, cn, focusRing, toneSolid } from '@bylinecrm/ui';
import { Handshake } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { usePipeline, usePipelines } from '../../../api/deals';
import type { OpportunityView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { paths } from '../../paths';
import { STAGE_TONES } from '../deals/dealsView';
import { MoveSheet } from '../deals/MoveSheet';
import { NewDealDialog } from '../deals/NewDealDialog';
import { useDealMove } from '../deals/useDealMove';
import { RailCard, RailEmpty, RailLoading } from './RailCard';
import { useRelated } from './related';

interface Linked {
    id: string;
    name: string;
}

/**
 * A person's Deals rail: the deals they are the contact on, each with its stage, moved in place through the one
 * deal move (`useDealMove`: a close asks for its outcome, a backward move warns first), and "New deal" with the
 * person and their company filled in.
 */
export function PersonDeals({
    workspaceId,
    person,
    company,
}: {
    workspaceId: string;
    person: Linked;
    company: Linked | null;
}) {
    const deals = useRelated(workspaceId, 'opportunity', 'pointOfContactId', person.id);
    const edit = usePermission('deal:edit');
    const pipelines = usePipelines(workspaceId);
    const defaultPipeline = pipelines.data?.find((p) => p.isDefault) ?? pipelines.data?.[0];
    const [creating, setCreating] = useState(false);
    // A person's deals may sit in more than one pipeline; each pipeline's stages gate its own moves.
    const byPipeline = useMemo(() => {
        const groups = new Map<string, OpportunityView[]>();
        for (const deal of deals.items) groups.set(deal.pipelineId, [...(groups.get(deal.pipelineId) ?? []), deal]);
        return [...groups];
    }, [deals.items]);
    const currency = deals.items[0]?.currency ?? DEFAULT_CURRENCY;

    return (
        <RailCard
            title="Deals"
            icon={<Handshake />}
            count={deals.data && !deals.more ? deals.items.length : undefined}
            action={
                edit.allowed ? (
                    <Button size="xs" shape="square" variant="ghost" onClick={() => setCreating(true)}>
                        + New deal
                    </Button>
                ) : undefined
            }
        >
            {deals.isPending ? (
                <RailLoading />
            ) : deals.items.length === 0 ? (
                <RailEmpty>No deals with this person as the contact.</RailEmpty>
            ) : (
                byPipeline.map(([pipelineId, items]) => (
                    <PipelineDeals key={pipelineId} workspaceId={workspaceId} pipelineId={pipelineId} deals={items} />
                ))
            )}
            {edit.allowed && (
                <NewDealDialog
                    workspaceId={workspaceId}
                    pipeline={defaultPipeline}
                    open={creating}
                    onOpenChange={setCreating}
                    currency={currency}
                    contact={person}
                    company={company}
                />
            )}
        </RailCard>
    );
}

/** One pipeline's deals in the rail: a link to each, and its stage as a control that opens "Move to stage". */
function PipelineDeals({
    workspaceId,
    pipelineId,
    deals,
}: {
    workspaceId: string;
    pipelineId: string;
    deals: readonly OpportunityView[];
}) {
    const pipeline = usePipeline(workspaceId, pipelineId);
    const move = useDealMove(workspaceId, pipeline.data);
    const mayMove = usePermission('deal:move');
    const [moving, setMoving] = useState<OpportunityView | null>(null);
    const stages = useMemo(
        () => [...(pipeline.data?.stages ?? [])].sort((a, b) => a.position - b.position),
        [pipeline.data],
    );
    const stageOf = (deal: OpportunityView) => stages.find((s) => s.id === deal.stageId);

    return (
        <>
            {deals.map((deal) => {
                const stage = stageOf(deal);
                return (
                    <div
                        key={deal.id}
                        className="flex items-center gap-2 border-b border-border px-4 py-3 last:border-b-0"
                    >
                        <Link
                            to={paths.deal(workspaceId, deal.id)}
                            className={cn('min-w-0 flex-1 rounded-sm hover:underline', focusRing)}
                        >
                            <span className="block truncate font-medium text-text">{deal.name}</span>
                            <span className="block truncate text-xs text-text-muted">{`${deal.daysInStage}d in stage`}</span>
                        </Link>
                        <button
                            type="button"
                            disabled={!mayMove.allowed || !stage || move.isMoving}
                            title={mayMove.allowed ? undefined : mayMove.reason}
                            aria-label={stage ? `Stage: ${stage.name}. Move ${deal.name}` : 'Stage'}
                            onClick={() => setMoving(deal)}
                            className={cn(
                                'inline-flex max-w-36 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs',
                                'hover:bg-surface-raised disabled:cursor-default disabled:hover:bg-transparent',
                                focusRing,
                            )}
                        >
                            {stage && (
                                <span
                                    aria-hidden
                                    className={cn('size-2 shrink-0 rounded-full', toneSolid[STAGE_TONES[stage.colour]])}
                                />
                            )}
                            <span className="truncate">{stage?.name ?? '…'}</span>
                        </button>
                    </div>
                );
            })}
            {move.dialogs}
            <MoveSheet deal={moving} stages={stages} onClose={() => setMoving(null)} onPick={move.request} />
        </>
    );
}
