import {
    Badge,
    Button,
    DataTableChrome,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    DropdownMenuItem,
    EmptyState,
    Field,
    Input,
    cn,
    focusRing,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { usePipelines } from '../../../api/queries';
import { useCreatePipeline, useRemovePipeline, useUpdatePipeline } from '../../../api/settings';
import type { PipelineView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';

/**
 * The workspace's pipelines (FR-CRMS-9): each opens its stages and rules. Creating, renaming the
 * default and deleting need `pipeline:configure`; without it the list reads only.
 */
export function Pipelines() {
    const workspaceId = useWorkspaceId();
    const pipelines = usePipelines(workspaceId);
    const canConfigure = useCan('pipeline:configure');
    const remove = useRemovePipeline(workspaceId);
    const [creating, setCreating] = useState(false);
    const [deleting, setDeleting] = useState<PipelineView | null>(null);
    const [defaulting, setDefaulting] = useState<PipelineView | null>(null);
    if (pipelines.isError) throw pipelines.error;
    const rows = pipelines.data ?? [];

    return (
        <>
            <DataTableChrome
                tabs={[{ id: 'all', label: 'Pipelines', count: rows.length }]}
                activeTab="all"
                {...(canConfigure && {
                    toolbar: {
                        extra: (
                            <Button
                                data-primary-action
                                data-primary-dialog
                                variant="primary"
                                shape="square"
                                size="sm"
                                onClick={() => setCreating(true)}
                            >
                                New pipeline
                            </Button>
                        ),
                    },
                })}
                data={{
                    label: 'Pipelines',
                    loading: pipelines.isPending,
                    rows,
                    getRowId: (p) => p.id,
                    empty: (
                        <EmptyState
                            className="m-4"
                            title="No pipelines"
                            body="A pipeline is the stages a deal moves through, from first contact to won or lost."
                        />
                    ),
                    columns: [
                        {
                            id: 'name',
                            header: 'Pipeline',
                            cell: (p) => (
                                <span className="inline-flex items-center gap-2">
                                    <Link
                                        to={paths.settingsPipeline(workspaceId, p.id)}
                                        className={cn(
                                            'inline-flex items-center font-medium hover:underline max-md:min-h-touch',
                                            focusRing,
                                        )}
                                    >
                                        {p.name}
                                    </Link>
                                    {p.isDefault && (
                                        <Badge status="accent" shape="pill">
                                            Default
                                        </Badge>
                                    )}
                                </span>
                            ),
                        },
                        {
                            id: 'stages',
                            header: 'Stages',
                            muted: true,
                            cell: (p) => p.stages.map((s) => s.name).join(' → '),
                        },
                    ],
                    ...(canConfigure && {
                        rowActions: {
                            label: (p: PipelineView) => p.name,
                            items: (p: PipelineView) =>
                                p.isDefault ? null : (
                                    <>
                                        <DropdownMenuItem onSelect={() => setDefaulting(p)}>
                                            Make default
                                        </DropdownMenuItem>
                                        <DropdownMenuItem destructive onSelect={() => setDeleting(p)}>
                                            Delete
                                        </DropdownMenuItem>
                                    </>
                                ),
                        },
                    }),
                }}
            />
            {creating && <CreatePipelineDialog workspaceId={workspaceId} onClose={() => setCreating(false)} />}
            {defaulting && (
                <MakeDefaultDialog
                    workspaceId={workspaceId}
                    pipeline={defaulting}
                    onClose={() => setDefaulting(null)}
                />
            )}
            <ConfirmDialog
                open={deleting !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setDeleting(null);
                        remove.reset();
                    }
                }}
                title={`Delete ${deleting?.name ?? 'pipeline'}?`}
                body="Only an empty pipeline can be deleted — deals in the trash count. The default pipeline cannot be deleted."
                confirm="Delete pipeline"
                pending={remove.isPending}
                error={remove.error ? failureText(remove.error) : undefined}
                onConfirm={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
            />
        </>
    );
}

/** A new pipeline starts with the default stages; its stages are edited on its own page. */
function CreatePipelineDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
    const create = useCreatePipeline(workspaceId);
    const navigate = useNavigate();
    const [name, setName] = useState('');
    const submit = (event: FormEvent) => {
        event.preventDefault();
        create.mutate(
            { name: name.trim() },
            { onSuccess: (pipeline) => navigate(paths.settingsPipeline(workspaceId, pipeline.id)) },
        );
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogTitle>New pipeline</DialogTitle>
                <DialogDescription>
                    It starts with the default stages. Rename, reorder or add stages on the next page.
                </DialogDescription>
                <form onSubmit={submit}>
                    <DialogBody>
                        <Field label="Name" required error={create.error ? failureText(create.error) : undefined}>
                            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
                        </Field>
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" shape="square" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            shape="square"
                            variant="primary"
                            loading={create.isPending}
                            disabled={!name.trim()}
                        >
                            Create pipeline
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** New deals land in the default pipeline unless someone picks another. */
function MakeDefaultDialog({
    workspaceId,
    pipeline,
    onClose,
}: {
    workspaceId: string;
    pipeline: PipelineView;
    onClose: () => void;
}) {
    const update = useUpdatePipeline(workspaceId, pipeline.id);
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogTitle>Make {pipeline.name} the default?</DialogTitle>
                <DialogDescription>
                    New deals start in the default pipeline unless someone picks another. The board opens on it.
                </DialogDescription>
                {update.error && (
                    <DialogBody>
                        <p role="alert" className="m-0 text-sm text-danger">
                            {failureText(update.error)}
                        </p>
                    </DialogBody>
                )}
                <DialogFooter>
                    <Button shape="square" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        shape="square"
                        variant="primary"
                        loading={update.isPending}
                        onClick={() => update.mutate({ isDefault: true }, { onSuccess: onClose })}
                    >
                        Make default
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
