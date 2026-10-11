import type { MailboxPurpose } from '@bylinecrm/shared';
import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    RadioGroup,
    type RadioOption,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { useConnectMailbox } from '../../../api/queries';
import { failureText } from '../../../lib/errors';
import { leaveFor } from '../../../lib/leaveFor';

/** The two purposes in the words a member chooses between (the API's `personal | pool`). */
export const PURPOSE_LABEL: Record<MailboxPurpose, string> = {
    personal: 'Personal',
    pool: 'Shared outreach',
};

const PURPOSES: readonly RadioOption<MailboxPurpose>[] = [
    {
        value: 'personal',
        label: 'Personal mailbox',
        description:
            'Your own mailbox. Your mail is matched to the people it concerns; only you see the message bodies.',
    },
    {
        value: 'pool',
        label: 'Shared outreach mailbox',
        description:
            'A mailbox outreach sends from. Anyone who can read a record sees the mail it holds about that record.',
    },
];

/**
 * Starts a Google connect (FR-CRMS-1): the member chooses what the mailbox is for — which cannot
 * change later — and the browser leaves for Google's consent screen. Google sends it back to the
 * API's callback, which returns here with `?connect=<result>`.
 */
export function ConnectMailboxDialog({
    workspaceId,
    open,
    onOpenChange,
}: {
    workspaceId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const connect = useConnectMailbox(workspaceId);
    const [purpose, setPurpose] = useState<MailboxPurpose>('personal');
    const submit = (event: FormEvent) => {
        event.preventDefault();
        connect.mutate({ purpose }, { onSuccess: (start) => leaveFor(start.authorizeUrl) });
    };
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) connect.reset();
                onOpenChange(next);
            }}
        >
            <DialogContent>
                <DialogTitle>Connect a mailbox</DialogTitle>
                <DialogDescription>
                    You sign in to Google next and allow send and read access — nothing broader.
                </DialogDescription>
                <form onSubmit={submit}>
                    <DialogBody className="flex flex-col gap-4">
                        <RadioGroup
                            legend="What is this mailbox for?"
                            options={PURPOSES}
                            value={purpose}
                            onValueChange={setPurpose}
                        />
                        <p className="m-0 text-[13px] text-text-muted">
                            You can’t change this later — to change it, disconnect the mailbox and connect it again.
                        </p>
                        {connect.isError && (
                            <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
                                {failureText(connect.error)}
                            </p>
                        )}
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" shape="square" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" shape="square" loading={connect.isPending}>
                            Continue to Google
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
