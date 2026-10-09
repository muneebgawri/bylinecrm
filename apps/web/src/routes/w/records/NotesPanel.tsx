import type { RecordTarget, RichText } from '@bylinecrm/shared';
import { Button, Input, Skeleton } from '@bylinecrm/ui';
import { lazy, Suspense, useState } from 'react';
import { useDeleteNote, useMembersSummary, useNotes, useSaveNote } from '../../../api/queries';
import type { NoteView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { formatWhen } from '../../../lib/format';
import { messageFor } from './InlineEdit';
import { RailCard, RailEmpty, RailLoading } from './RailCard';
import { RichTextView } from './RichTextView';

const NoteEditor = lazy(() => import('./NoteEditor'));
const EMPTY: RichText = { type: 'doc', content: [{ type: 'paragraph' }] };

/**
 * Notes on a record: the rail card lists them newest first; "+ Add note" and a note's own Edit
 * open the editor in place. Delete asks once, inside the card (no `confirm()`).
 */
export function NotesPanel({
    workspaceId,
    target,
    open,
    onOpenChange,
}: {
    workspaceId: string;
    target: RecordTarget;
    /** The page's `n` shortcut opens the editor; the card reports when it closes. */
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const notes = useNotes(workspaceId, target);
    const write = usePermission('note:write');
    const [editing, setEditing] = useState<NoteView | null>(null);
    const items = notes.data?.pages.flatMap((p) => p.items) ?? [];

    return (
        <RailCard
            title="Notes"
            count={notes.data ? items.length : undefined}
            action={
                write.allowed ? (
                    <Button
                        size="xs"
                        shape="square"
                        variant="ghost"
                        onClick={() => {
                            setEditing(null);
                            onOpenChange(true);
                        }}
                    >
                        + Add note
                    </Button>
                ) : (
                    <span className="text-xs text-text-faint" title={write.reason}>
                        read only
                    </span>
                )
            }
        >
            {open && (
                <NoteForm
                    workspaceId={workspaceId}
                    target={target}
                    note={editing}
                    onDone={() => {
                        setEditing(null);
                        onOpenChange(false);
                    }}
                />
            )}
            {notes.isPending ? (
                <RailLoading />
            ) : notes.isError ? (
                <RailEmpty>Notes could not be loaded.</RailEmpty>
            ) : items.length === 0 && !open ? (
                <RailEmpty>No notes yet.</RailEmpty>
            ) : (
                <ul className="m-0 list-none p-0">
                    {items.map((note) => (
                        <NoteRow
                            key={note.id}
                            workspaceId={workspaceId}
                            target={target}
                            note={note}
                            canEdit={write.allowed}
                            onEdit={() => {
                                setEditing(note);
                                onOpenChange(true);
                            }}
                        />
                    ))}
                    {notes.hasNextPage && (
                        <li className="px-4 py-2 text-center">
                            <Button size="xs" shape="square" variant="ghost" onClick={() => void notes.fetchNextPage()}>
                                Load older
                            </Button>
                        </li>
                    )}
                </ul>
            )}
        </RailCard>
    );
}

function NoteRow({
    workspaceId,
    target,
    note,
    canEdit,
    onEdit,
}: {
    workspaceId: string;
    target: RecordTarget;
    note: NoteView;
    canEdit: boolean;
    onEdit: () => void;
}) {
    const remove = useDeleteNote(workspaceId, target);
    const members = useMembersSummary(workspaceId);
    const [confirming, setConfirming] = useState(false);
    const author = note.authorId
        ? (members.data?.find((m) => m.memberId === note.authorId)?.name ?? 'A member')
        : 'System';
    return (
        <li className="border-b border-border px-4 py-3 last:border-b-0">
            <div className="flex items-baseline gap-2">
                <span className="truncate text-[13px] font-medium">{note.title || 'Untitled note'}</span>
                <span className="ml-auto shrink-0 text-xs text-text-faint">
                    {author} · {formatWhen(note.updatedAt)}
                </span>
            </div>
            <RichTextView body={note.body} className="mt-1 text-text-muted" />
            {canEdit && (
                <div className="mt-1.5 flex gap-1">
                    {confirming ? (
                        <>
                            <span className="text-xs text-text-muted">Delete this note?</span>
                            <Button
                                size="xs"
                                shape="square"
                                variant="danger"
                                disabled={remove.isPending}
                                onClick={() => remove.mutate(note.id)}
                            >
                                Delete
                            </Button>
                            <Button size="xs" shape="square" variant="ghost" onClick={() => setConfirming(false)}>
                                Keep
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button size="xs" shape="square" variant="ghost" onClick={onEdit}>
                                Edit
                            </Button>
                            <Button size="xs" shape="square" variant="ghost" onClick={() => setConfirming(true)}>
                                Delete
                            </Button>
                        </>
                    )}
                    {remove.isError && (
                        <span role="alert" className="text-xs text-danger">
                            {messageFor(remove.error, 'note')}
                        </span>
                    )}
                </div>
            )}
        </li>
    );
}

function NoteForm({
    workspaceId,
    target,
    note,
    onDone,
}: {
    workspaceId: string;
    target: RecordTarget;
    note: NoteView | null;
    onDone: () => void;
}) {
    const save = useSaveNote(workspaceId, target);
    const [title, setTitle] = useState(note?.title ?? '');
    const [body, setBody] = useState<RichText>(note?.body ?? EMPTY);
    return (
        <form
            className="flex flex-col gap-2 border-b border-border bg-surface-raised px-4 py-3"
            onSubmit={(e) => {
                e.preventDefault();
                save.mutate(note ? { id: note.id, title, body } : { title, body }, { onSuccess: onDone });
            }}
            onKeyDown={(e) => {
                if (e.key === 'Escape') onDone();
            }}
        >
            <Input
                aria-label="Note title"
                placeholder="Title (optional)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="h-8 text-[13px]"
                autoFocus
            />
            <Suspense fallback={<Skeleton className="h-28" />}>
                <NoteEditor aria-label="Note" value={body} onChange={setBody} placeholder="Write the note…" />
            </Suspense>
            {save.isError && (
                <p role="alert" className="m-0 text-xs text-danger">
                    {messageFor(save.error, 'body')}
                </p>
            )}
            <div className="flex justify-end gap-2">
                <Button type="button" size="sm" shape="square" variant="ghost" onClick={onDone}>
                    Cancel
                </Button>
                <Button type="submit" size="sm" shape="square" variant="primary" disabled={save.isPending}>
                    {note ? 'Save' : 'Add note'}
                </Button>
            </div>
        </form>
    );
}
