import { Badge, Button, cn, focusRing, Input, LoadingRegion, Skeleton } from '@bylinecrm/ui';
import { ChevronLeft } from 'lucide-react';
import { useCallback, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { usePipeline, useRules } from '../../../api/deals';
import { useOrderStages, useUpdatePipeline, useUpdateStage } from '../../../api/settings';
import type { StageView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { failureText } from '../../../lib/errors';
import { usePipelineId, useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { CadenceSection } from './CadenceSection';
import { RulesSection } from './RulesSection';
import { StageDeleteDialog } from './StageDeleteDialog';
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
    const canCadence = useCan('pipeline:cadence');
    const order = useOrderStages(workspaceId, pipelineId);
    const updateStage = useUpdateStage(workspaceId, pipelineId);
    const [editing, setEditing] = useState<StageView | 'new' | null>(null);
    const [deleting, setDeleting] = useState<StageView | null>(null);
    const [announcement, setAnnouncement] = useState('');
    const announce = useCallback((text: string) => setAnnouncement(text), []);
    if (pipeline.isError) throw pipeline.error;

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
                <LoadingRegion label="Loading pipeline" className="grid gap-3">
                    <Skeleton className="h-7 w-56" />
                    <Skeleton className="h-64 w-full" />
                </LoadingRegion>
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
                                    data-primary-dialog
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
                            announce={announce}
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
                    <CadenceSection
                        key={pipeline.data.stages.map((s) => `${s.id}:${s.cadenceDays}`).join()}
                        workspaceId={workspaceId}
                        pipeline={pipeline.data}
                        canEdit={canCadence}
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
            {/* The page's one polite live region: stage moves and drags are announced here (FR-CRMS-UI-8). */}
            <div aria-live="polite" aria-atomic="true" className="sr-only">
                {announcement}
            </div>
            {pipeline.data && (
                <StageDeleteDialog
                    workspaceId={workspaceId}
                    pipelineId={pipelineId}
                    stage={deleting}
                    stages={pipeline.data.stages}
                    onClose={() => setDeleting(null)}
                />
            )}
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
