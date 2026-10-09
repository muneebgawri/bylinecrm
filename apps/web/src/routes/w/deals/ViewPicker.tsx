import type { FilterGroup, SavedView, ViewSort } from '@bylinecrm/shared';
import {
    Badge,
    Button,
    Checkbox,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Field,
    Input,
    toast,
} from '@bylinecrm/ui';
import { ChevronDown } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import { useCreateView, useDeleteView, useUpdateView, useViews } from '../../../api/queries';

/** The value the radio group uses for "no saved view". */
const NO_VIEW = '';

export interface ViewPickerProps {
    workspaceId: string;
    /** The selected saved view's id, or undefined for "All deals". */
    viewId: string | undefined;
    onSelect: (view: SavedView | null) => void;
    /** What would be saved: the current inline filter and sort. */
    current: { filter: FilterGroup | null; sorts: ViewSort[] };
    memberId: string | null;
    canSave: boolean;
    canShare: boolean;
}

/**
 * Saved views of deals (FR-CRMS-UI-1, P1-4): shared ones and the member's own, "Save view" for the
 * current filter and sort (`view:save`), sharing with the workspace (`view:share`), and deleting a
 * view the member may change. The API is the gate; the menu only offers what it would allow.
 */
export function ViewPicker({ workspaceId, viewId, onSelect, current, memberId, canSave, canShare }: ViewPickerProps) {
    const views = useViews(workspaceId, 'opportunity');
    const update = useUpdateView(workspaceId, 'opportunity');
    const remove = useDeleteView(workspaceId, 'opportunity');
    const [saving, setSaving] = useState(false);
    const list = views.data ?? [];
    const selected = list.find((v) => v.id === viewId);
    const mine = (v: SavedView) => v.ownerMemberId !== null && v.ownerMemberId === memberId;
    const mayChange = (v: SavedView) => (v.isShared ? canShare : mine(v) && canSave);
    const hasDraft = current.filter !== null || current.sorts.length > 0;

    const fail = (what: string) => (error: unknown) =>
        toast({
            title: what,
            description: error instanceof ApiError ? error.message : 'The server could not be reached.',
            tone: 'danger',
        });

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="secondary"
                        shape="square"
                        aria-label={`Saved view: ${selected?.name ?? 'All deals'}`}
                    >
                        <span className="max-w-44 truncate">{selected?.name ?? 'All deals'}</span>
                        {selected?.isShared && (
                            <Badge shape="pill" status="neutral">
                                shared
                            </Badge>
                        )}
                        <ChevronDown aria-hidden />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                    <DropdownMenuLabel>Views</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                        value={viewId ?? NO_VIEW}
                        onValueChange={(id) => onSelect(list.find((v) => v.id === id) ?? null)}
                    >
                        <DropdownMenuRadioItem value={NO_VIEW}>All deals</DropdownMenuRadioItem>
                        {list.map((v) => (
                            <DropdownMenuRadioItem key={v.id} value={v.id}>
                                <span className="truncate">{v.name}</span>
                                <span className="ml-auto pl-2 text-xs text-text-faint">
                                    {v.isShared ? 'Shared' : 'Mine'}
                                </span>
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                    {(canSave || (selected && mayChange(selected))) && <DropdownMenuSeparator />}
                    {canSave && (
                        <DropdownMenuItem disabled={!hasDraft} onSelect={() => setSaving(true)}>
                            Save current filters as a view…
                        </DropdownMenuItem>
                    )}
                    {selected && mayChange(selected) && hasDraft && (
                        <DropdownMenuItem
                            onSelect={() =>
                                update.mutate(
                                    { viewId: selected.id, filter: current.filter, sorts: current.sorts },
                                    {
                                        onSuccess: () => toast({ title: `${selected.name} updated`, tone: 'success' }),
                                        onError: fail('The view was not updated'),
                                    },
                                )
                            }
                        >
                            Update “{selected.name}”
                        </DropdownMenuItem>
                    )}
                    {selected && canShare && mine(selected) && (
                        <DropdownMenuItem
                            onSelect={() =>
                                update.mutate(
                                    { viewId: selected.id, isShared: !selected.isShared },
                                    { onError: fail('Sharing was not changed') },
                                )
                            }
                        >
                            {selected.isShared ? 'Stop sharing with the workspace' : 'Share with the workspace'}
                        </DropdownMenuItem>
                    )}
                    {selected && mayChange(selected) && (
                        <DropdownMenuItem
                            destructive
                            onSelect={() =>
                                remove.mutate(selected.id, {
                                    onSuccess: () => {
                                        onSelect(null);
                                        toast({ title: `${selected.name} deleted`, tone: 'success' });
                                    },
                                    onError: fail('The view was not deleted'),
                                })
                            }
                        >
                            Delete “{selected.name}”
                        </DropdownMenuItem>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            <SaveViewDialog
                open={saving}
                onOpenChange={setSaving}
                workspaceId={workspaceId}
                current={current}
                canShare={canShare}
                onSaved={(view) => {
                    setSaving(false);
                    onSelect(view);
                }}
            />
        </>
    );
}

function SaveViewDialog({
    open,
    onOpenChange,
    workspaceId,
    current,
    canShare,
    onSaved,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    workspaceId: string;
    current: ViewPickerProps['current'];
    canShare: boolean;
    onSaved: (view: SavedView) => void;
}) {
    const create = useCreateView(workspaceId);
    const [name, setName] = useState('');
    const [shared, setShared] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const shareId = useId();

    function submit(event: FormEvent) {
        event.preventDefault();
        if (!name.trim()) return setError('Name the view.');
        create.mutate(
            {
                object: 'opportunity',
                name: name.trim(),
                filter: current.filter,
                sorts: current.sorts,
                isShared: canShare && shared,
            },
            {
                onSuccess: (view) => {
                    toast({ title: `${view.name} saved`, tone: 'success' });
                    setName('');
                    setShared(false);
                    onSaved(view);
                },
                onError: (e) => setError(e instanceof ApiError ? e.message : 'The server could not be reached.'),
            },
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <form onSubmit={submit} noValidate className="contents">
                    <DialogTitle>Save view</DialogTitle>
                    <DialogDescription>Saves the current filters and sort under a name.</DialogDescription>
                    <DialogBody className="flex flex-col gap-4">
                        <Field label="Name" required error={error}>
                            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                        </Field>
                        {canShare && (
                            <label htmlFor={shareId} className="flex items-center gap-2 text-sm">
                                <Checkbox
                                    id={shareId}
                                    checked={shared}
                                    onCheckedChange={(c) => setShared(c === true)}
                                />
                                Share with the workspace
                            </label>
                        )}
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" variant="secondary" shape="square" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" shape="square" loading={create.isPending}>
                            Save view
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
