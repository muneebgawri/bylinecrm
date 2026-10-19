import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Field,
    Textarea,
    toast,
} from '@bylinecrm/ui';
import { useImperativeHandle, useState, type FormEvent, type Ref } from 'react';
import { useSaveTask } from '../../../api/records';
import { failureText } from '../../../lib/errors';
import type { RecordComposeHandle } from '../mail/RecordCompose';

const TITLE_MAX = 300;

/**
 * GUARD-1 (#202): on another member's lead, the record shows "Ask <owner> to introduce you" where the composer
 * would be — the server would refuse the send anyway (`recipient.guarded`). Asking makes a task on the person,
 * assigned to the owner, so they are told (the bell) and it sits in their My tasks until they act on it.
 */
export function AskIntroduction({
    workspaceId,
    personId,
    personName,
    ownerId,
    ownerName,
    requesterName,
    handle,
}: {
    workspaceId: string;
    personId: string;
    personName: string;
    ownerId: string;
    ownerName: string;
    requesterName: string;
    handle?: Ref<RecordComposeHandle>;
}) {
    const [open, setOpen] = useState(false);
    const [note, setNote] = useState('');
    const save = useSaveTask(workspaceId, { type: 'person', id: personId });
    useImperativeHandle(handle, () => ({ start: () => setOpen(true) }), []);

    const close = () => {
        setNote('');
        setOpen(false);
    };
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const ask = `Introduce ${requesterName} to ${personName}`;
        const title = (note.trim() ? `${ask}: ${note.trim()}` : ask).slice(0, TITLE_MAX);
        save.mutate(
            { title, assigneeId: ownerId },
            {
                onSuccess: () => {
                    toast({ tone: 'success', title: `Asked ${ownerName}` });
                    close();
                },
                onError: (err) => toast({ tone: 'danger', title: 'Not asked', description: failureText(err) }),
            },
        );
    };

    return (
        <div className="rounded-md border border-border p-3 text-sm">
            <p className="m-0 mb-2 text-text-muted">
                {personName} is {ownerName}’s lead. Mail to them goes through {ownerName}.
            </p>
            <Button size="sm" shape="square" onClick={() => setOpen(true)}>
                Ask {ownerName} to introduce you
            </Button>
            <Dialog open={open} onOpenChange={(o) => !o && close()}>
                <DialogContent>
                    <DialogTitle>Ask {ownerName} to introduce you</DialogTitle>
                    <DialogDescription>
                        {ownerName} gets a task on {personName} and is told in the bell.
                    </DialogDescription>
                    <form onSubmit={submit}>
                        <DialogBody>
                            <Field label="Why (optional)">
                                <Textarea value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
                            </Field>
                        </DialogBody>
                        <DialogFooter>
                            <Button type="button" onClick={close}>
                                Cancel
                            </Button>
                            <Button type="submit" variant="primary" loading={save.isPending}>
                                Ask
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </div>
    );
}
