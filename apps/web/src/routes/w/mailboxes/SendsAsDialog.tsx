import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Field,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    toast,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { useUpdateMailbox } from '../../../api/mailAdmin';
import { useMembersSummary } from '../../../api/records';
import type { MailboxView } from '../../../api/types';
import { failureText } from '../../../lib/errors';

/**
 * Who a shared outreach mailbox sends as (an admin's choice): its owner gives the From name, `{{sender.*}}` and the
 * signature's details. A pool mailbox is owned by whoever connected it — often an admin connecting a teammate's
 * mailbox — so the admin hands it to the member it belongs to. Current members only.
 */
export function SendsAsDialog({
    workspaceId,
    mailbox,
    onOpenChange,
}: {
    workspaceId: string;
    mailbox: MailboxView | null;
    onOpenChange: (open: boolean) => void;
}) {
    const members = useMembersSummary(workspaceId);
    const update = useUpdateMailbox(workspaceId);
    const [chosen, setChosen] = useState<string | null>(null);
    const current = (members.data ?? []).filter((m) => !m.leftAt);
    const value = chosen ?? mailbox?.ownerMemberId ?? '';

    const close = (open: boolean) => {
        if (!open) {
            setChosen(null);
            update.reset();
        }
        onOpenChange(open);
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!mailbox || !value) return;
        if (value === mailbox.ownerMemberId) return close(false);
        update.mutate(
            { mailboxId: mailbox.id, input: { ownerMemberId: value } },
            {
                onSuccess: () => {
                    const name = current.find((m) => m.memberId === value)?.name ?? 'the member';
                    toast({ title: `${mailbox.email} now sends as ${name}`, tone: 'success' });
                    close(false);
                },
            },
        );
    };

    return (
        <Dialog open={mailbox !== null} onOpenChange={close}>
            <DialogContent>
                <DialogTitle>Who does {mailbox?.email} send as?</DialogTitle>
                <DialogDescription>
                    Sequence emails from this mailbox use this member’s name as the sender, their details in the
                    signature and in templates, and they own the mailbox. Choose the person the mailbox belongs to.
                </DialogDescription>
                <form onSubmit={submit}>
                    <DialogBody className="flex flex-col gap-4">
                        <Field label="Sends as">
                            <Select value={value} onValueChange={setChosen}>
                                <SelectTrigger aria-label="Sends as">
                                    <SelectValue placeholder="Choose a member" />
                                </SelectTrigger>
                                <SelectContent>
                                    {current.map((m) => (
                                        <SelectItem key={m.memberId} value={m.memberId}>
                                            {m.name ?? 'Unnamed member'}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        {update.isError && (
                            <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
                                {failureText(update.error)}
                            </p>
                        )}
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" shape="square" onClick={() => close(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" shape="square" loading={update.isPending}>
                            Save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
