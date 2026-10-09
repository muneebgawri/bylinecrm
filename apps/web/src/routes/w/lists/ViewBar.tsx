import type { RecordObject, SavedView } from '@bylinecrm/shared';
import {
    Button,
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    focusRing,
    toast,
} from '@bylinecrm/ui';
import { useState } from 'react';
import type { ListCount } from '../../../api/lists';
import { useCreateView, useDeleteView, useUpdateView } from '../../../api/queries';
import { LIST_COPY } from './listConfig';
import { ConfirmDialog, failureText, SaveViewDialog } from './ListDialogs';

/** The "All" tab — no saved view. */
const ALL = '__all__';

/** "1,034", or "10,000+" past the API's count cap. */
export function formatCount(count: ListCount): string {
    return `${count.total.toLocaleString()}${count.exact ? '' : '+'}`;
}

export interface ViewBarProps {
    object: RecordObject;
    views: readonly SavedView[];
    viewId: string | undefined;
    onSelect: (id: string | undefined) => void;
    memberId: string | null;
    canSave: boolean;
    canShare: boolean;
    /** The page has inline changes a view could keep. */
    dirty: boolean;
    /** What "Save" writes: the effective filter, sorts and columns. */
    current: Pick<SavedView, 'filter' | 'sorts' | 'columns'>;
    workspaceId: string;
    onSaved: () => void;
    phone: boolean;
    /** Counts per tab by view id (`undefined` = "All"); a tab without one shows none. */
    counts?: ReadonlyMap<string | undefined, ListCount> | undefined;
}

/**
 * Saved views for every list (P1-UI-2, shared by deals since P1-UI-6): tabs on a desktop, a chip
 * row that scrolls inside itself on a phone, each with its count, and the menu that saves, shares
 * and deletes them — offered only as far as the API would allow (FR-CRMS-UI-6).
 */
export function ViewBar({
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
    counts,
}: ViewBarProps) {
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
        { id: ALL, view: undefined, label: `All ${LIST_COPY[object].plural}` },
        ...views.map((v) => ({ id: v.id, view: v.id, label: v.name })),
    ];

    return (
        <div className="flex items-center gap-2">
            <div
                role="tablist"
                aria-label="Views"
                className="scrollbar-hidden flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5"
            >
                {tabs.map((tab) => {
                    const active = (tab.id === ALL && !viewId) || tab.id === viewId;
                    const count = counts?.get(tab.view);
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => onSelect(tab.view)}
                            className={cn(
                                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-transparent px-3 text-sm font-medium whitespace-nowrap text-text-muted max-md:h-touch max-md:rounded-full max-md:border-border max-md:bg-surface',
                                active &&
                                    'border-border bg-surface text-text shadow-sm max-md:border-accent max-md:bg-accent-soft max-md:text-accent',
                                focusRing,
                            )}
                        >
                            {tab.label}
                            {count && (
                                <span className="text-xs font-normal text-text-faint tabular-nums">
                                    {formatCount(count)}
                                </span>
                            )}
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
