import { Badge, Button, cn, focusRing, Input, Skeleton } from '@bylinecrm/ui';
import { ChevronLeft } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { usePipeline, useRules } from '../../../api/queries';
import { useOrderStages, useRemoveStage, useUpdatePipeline, useUpdateStage } from '../../../api/settings';
import type { StageView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { DEALS_PARAMS } from '../deals/dealsView';
import { usePipelineId, useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { RulesSection } from './RulesSection';
import { StageEditor } from './StageEditor';
import { StageList } from './StageList';

/**
 * One pipeline (FR-CRMS-9): its stages — order, names, colours, probabilities, how long a deal may
 * sit before the board flags it, and which stages close a deal — and its stage rules. Writes need
 * `pipeline:configure`; without it the page reads only (FR-CRMS-UI-6).
 */
export function PipelineDetail() {
    const workspaceId = useWorkspaceId();
    const pipelineId = usePipelineId();
    const pipeline = usePipeline(workspaceId, pipelineId);
    const rules = useRules(workspaceId, pipelineId);
    const canConfigure = useCan('pipeline:configure');
    const order = useOrderStages(workspaceId, pipelineId);
    const updateStage = useUpdateStage(workspaceId, pipelineId);
    const removeStage = useRemoveStage(workspaceId, pipelineId);
    const [editing, setEditing] = useState<StageView | 'new' | null>(null);
    const [deleting, setDeleting] = useState<StageView | null>(null);
    if (pipeline.isError) throw pipeline.error;

    const closeDelete = () => {
        setDeleting(null);
        removeStage.reset();
    };

    return (
        <div className="grid gap-4">
            <Link
                to={paths.settingsPipelines(workspaceId)}
                className={cn(
                    'inline-flex w-fit items-center gap-1 text-sm text-text-muted hover:text-text max-md:min-h-touch',
                    focusRing,
                )}
            >
                <ChevronLeft aria-hidden className="size-4" />
                Pipelines
            </Link>
            {pipeline.isPending ? (
                <div className="grid gap-3" aria-busy="true">
                    <Skeleton className="h-7 w-56" />
                    <Skeleton className="h-64 w-full" />
                </div>
            ) : (
                <>
                    <PipelineName
                        workspaceId={workspaceId}
                        pipelineId={pipelineId}
                        name={pipeline.data.name}
                        isDefault={pipeline.data.isDefault}
                        canConfigure={canConfigure}
                    />
                    <section aria-labelledby="stages-heading" className="rounded-lg border border-border bg-surface">
                        <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                            <div className="grid gap-0.5">
                                <h3 id="stages-heading" className="m-0 text-sm font-semibold">
                                    Stages
                                </h3>
                                <p className="m-0 text-xs text-text-muted">
                                    The order deals move through, left to right on the board.
                                </p>
                            </div>
                            {canConfigure && (
                                <Button
                                    data-primary-action
                                    className="ml-auto"
                                    shape="square"
                                    size="sm"
                                    variant="primary"
                                    onClick={() => setEditing('new')}
                                >
                                    Add stage
                                </Button>
                            )}
                        </header>
                        <StageList
                            stages={pipeline.data.stages}
                            canConfigure={canConfigure}
                            onReorder={(ids) => order.mutate(ids)}
                            onRename={(stage, name) => updateStage.mutate({ stageId: stage.id, name })}
                            onEdit={setEditing}
                            onDelete={setDeleting}
                        />
                        {(order.error ?? updateStage.error) && (
                            <p role="alert" className="m-0 border-t border-border px-4 py-2 text-sm text-danger">
                                {failureText(order.error ?? updateStage.error)}
                            </p>
                        )}
                    </section>
                    <RulesSection
                        workspaceId={workspaceId}
                        pipelineId={pipelineId}
                        rules={rules.data ?? []}
                        stages={pipeline.data.stages}
                        canConfigure={canConfigure}
                    />
                </>
            )}
            {editing !== null && (
                <StageEditor
                    workspaceId={workspaceId}
                    pipelineId={pipelineId}
                    stage={editing === 'new' ? null : editing}
                    onClose={() => setEditing(null)}
                />
            )}
            <ConfirmDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && closeDelete()}
                title={`Delete ${deleting?.name ?? 'stage'}?`}
                body="A stage can go only when no deal is in it — the trash included — and no rule moves deals into it."
                confirm="Delete stage"
                pending={removeStage.isPending}
                error={removeStage.error ? failureText(removeStage.error) : undefined}
                onConfirm={() => deleting && removeStage.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
            >
                {removeStage.error && (
                    <Link
                        to={`${paths.deals(workspaceId)}?${DEALS_PARAMS.pipeline}=${pipelineId}`}
                        className={cn('w-fit text-sm text-accent underline-offset-4 hover:underline', focusRing)}
                    >
                        Open this pipeline’s deals
                    </Link>
                )}
            </ConfirmDialog>
        </div>
    );
}

/** The pipeline's name, renamed in place: Enter or leaving the field saves, Escape keeps the old one. */
function PipelineName({
    workspaceId,
    pipelineId,
    name,
    isDefault,
    canConfigure,
}: {
    workspaceId: string;
    pipelineId: string;
    name: string;
    isDefault: boolean;
    canConfigure: boolean;
}) {
    const update = useUpdatePipeline(workspaceId, pipelineId);
    const [draft, setDraft] = useState<string | null>(null);
    const save = () => {
        const next = draft?.trim();
        setDraft(null);
        if (next && next !== name) update.mutate({ name: next });
    };
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            save();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(null);
        }
    };
    return (
        <div className="flex flex-wrap items-center gap-2">
            {draft !== null ? (
                <Input
                    aria-label="Pipeline name"
                    className="max-w-sm"
                    value={draft}
                    maxLength={120}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    onBlur={save}
                />
            ) : (
                <h2 className="m-0 text-lg font-semibold tracking-tight">{name}</h2>
            )}
            {isDefault && (
                <Badge status="accent" shape="pill">
                    Default
                </Badge>
            )}
            {canConfigure && draft === null && (
                <Button variant="ghost" shape="square" size="sm" onClick={() => setDraft(name)}>
                    Rename
                </Button>
            )}
            {update.error && (
                <p role="alert" className="m-0 w-full text-sm text-danger">
                    {failureText(update.error)}
                </p>
            )}
        </div>
    );
}
