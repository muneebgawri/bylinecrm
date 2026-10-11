import { Badge, Button } from '@bylinecrm/ui';
import { useState } from 'react';
import { useCancelMail, useRescheduleMail, useSendMail } from '../../../api/mail';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { formatSendAt } from './schedule';
import { SchedulePicker } from './SchedulePicker';
import type { PendingSend } from './sends';

/** The words a pending send's line starts with. */
export function pendingAction(send: PendingSend): string {
    const subject = send.subject ? `“${send.subject}”` : 'an email';
    return send.status === 'scheduled' ? `scheduled ${subject}` : `emailed ${subject}`;
}

/** Why a send failed, in words: the API's message, and the variables that had no value. */
export function failureReason(error: PendingSend['error']): string {
    if (!error) return 'The send failed.';
    if (error.fields?.length) return `${error.fields.join(', ')} had no value when it was due; it was not sent.`;
    return error.message;
}

/**
 * Where a send stands, under its timeline line (doc 50 §A): "Sending…", "Sent", "Failed" with the
 * reason and Retry, or "Scheduled for …" with Reschedule and Cancel. The status is announced
 * politely as it changes.
 */
export function SendStatus({ workspaceId, send }: { workspaceId: string; send: PendingSend }) {
    const resend = useSendMail(workspaceId);
    const reschedule = useRescheduleMail(workspaceId);
    const cancel = useCancelMail(workspaceId);
    const [confirming, setConfirming] = useState(false);

    if (send.status === 'scheduled' && send.sendAt) {
        return (
            <>
                <Badge status="info" role="status">
                    Scheduled for {formatSendAt(send.sendAt, send.senderTimeZone)}
                </Badge>
                <SchedulePicker
                    title="Reschedule send"
                    confirm="Reschedule"
                    initial={new Date(send.sendAt)}
                    pending={reschedule.isPending}
                    error={reschedule.error ? failureText(reschedule.error) : undefined}
                    onConfirm={(at, timeZone) =>
                        reschedule.mutateAsync({
                            messageId: send.messageId,
                            reschedule: { sendAt: at.toISOString(), timeZone },
                        })
                    }
                    trigger={
                        <Button size="xs" shape="square" variant="secondary">
                            Reschedule
                        </Button>
                    }
                />
                <Button size="xs" shape="square" variant="ghost" onClick={() => setConfirming(true)}>
                    Cancel send
                </Button>
                <ConfirmDialog
                    open={confirming}
                    onOpenChange={(open) => {
                        setConfirming(open);
                        if (!open) cancel.reset();
                    }}
                    title="Cancel this send?"
                    body={`“${send.subject || 'This email'}” will not be sent. This cannot be undone.`}
                    confirm="Cancel send"
                    pending={cancel.isPending}
                    error={cancel.error ? failureText(cancel.error) : undefined}
                    onConfirm={() => cancel.mutate(send.messageId, { onSuccess: () => setConfirming(false) })}
                />
            </>
        );
    }
    if (send.status === 'failed') {
        const retry = send.session;
        return (
            <>
                <Badge status="danger" role="status">
                    Failed
                </Badge>
                <span className="text-xs text-text-muted">{failureReason(send.error)}</span>
                {retry && (
                    <Button
                        size="xs"
                        shape="square"
                        variant="secondary"
                        loading={resend.isPending}
                        onClick={() =>
                            resend.mutate({ send: retry.input, subject: retry.subject, replaces: send.messageId })
                        }
                    >
                        Retry
                    </Button>
                )}
                {resend.error && (
                    <span role="alert" className="text-xs text-danger">
                        {failureText(resend.error)}
                    </span>
                )}
            </>
        );
    }
    if (send.status === 'sent') {
        return (
            <Badge status="success" role="status">
                Sent
            </Badge>
        );
    }
    return (
        <Badge status="neutral" role="status">
            Sending…
        </Badge>
    );
}
