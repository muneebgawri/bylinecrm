import { Badge, Button } from '@bylinecrm/ui';
import { useState } from 'react';
import { useCancelMail, useRescheduleMail, useRetryMail } from '../../../api/mail';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { formatSendAt } from './schedule';
import { SchedulePicker } from './SchedulePicker';
import type { PendingSend } from './sends';

/** The words a pending send's line starts with. */
export function pendingAction(send: PendingSend): string {
    // Until the server has built it, a subject is as written: its variables read as their names.
    const text = send.subject.replace(/\{\{\s*([^}]+?)\s*\}\}/g, '$1');
    const subject = text ? `“${text}”` : 'an email';
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
    const retry = useRetryMail(workspaceId);
    const reschedule = useRescheduleMail(workspaceId);
    const cancel = useCancelMail(workspaceId);
    const [confirming, setConfirming] = useState(false);

    if (send.status === 'scheduled' && send.sendAt) {
        // The zone can be long ("America/Argentina/Buenos_Aires"): the badge wraps on a phone.
        const badge = (
            <Badge status="info" role="status" className="h-auto min-h-5.5 max-w-full py-0.5 whitespace-normal">
                Scheduled for {formatSendAt(send.sendAt, send.senderTimeZone)}
            </Badge>
        );
        // A colleague's send is shown read-only: only its sender or an admin may move it (#133).
        if (!send.canChange) return badge;
        return (
            <>
                {badge}
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
        return (
            <>
                <Badge status="danger" role="status">
                    Failed
                </Badge>
                <span className="text-xs text-text-muted">{failureReason(send.error)}</span>
                {/* Sent again by the server, rebuilt and checked as things stand now (#134). */}
                {send.canRetry && (
                    <Button
                        size="xs"
                        shape="square"
                        variant="secondary"
                        loading={retry.isPending}
                        onClick={() => retry.mutate(send.messageId)}
                    >
                        Retry
                    </Button>
                )}
                {retry.error && (
                    <span role="alert" className="text-xs text-danger">
                        {failureText(retry.error)}
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
