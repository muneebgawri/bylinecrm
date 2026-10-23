import type { RecordTarget } from '@bylinecrm/shared';
import { Badge, Button, cn, focusRing } from '@bylinecrm/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { useCancelMail, useRescheduleMail, useRetryMail } from '../../../api/mail';
import type { MailDraftView } from '../../../api/types';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { hasTracking, trackingText } from '../../../lib/tracking';
import { paths } from '../../paths';
import { formatSendAt } from './schedule';
import { SchedulePicker } from './SchedulePicker';
import type { PendingSend } from './sends';

/** A subject as written, before the server builds it: its variables read as their names. */
const asWritten = (subject: string) => subject.replace(/\{\{\s*([^}]+?)\s*\}\}/g, '$1').trim();

/** The words a pending send's line starts with. */
export function pendingAction(send: PendingSend): string {
    const text = asWritten(send.subject);
    const subject = text ? `“${text}”` : 'an email';
    // A queued follow-up says so, and which: it goes in the thread of the email before it.
    const what = send.followsOutboundId
        ? `follow-up${send.followUpNumber ? ` ${send.followUpNumber}` : ''} ${subject}`
        : subject;
    return send.status === 'scheduled' ? `scheduled ${what}` : `emailed ${what}`;
}

/** What cancelling a send calls off: it, and the follow-ups still scheduled after it. */
export function cancelText(send: PendingSend): string {
    const it = `“${send.subject || 'This email'}” will not be sent.`;
    const later =
        send.laterFollowUps === 0
            ? ''
            : send.laterFollowUps === 1
              ? ' Nor will the follow-up after it.'
              : ` Nor will the ${send.laterFollowUps} follow-ups after it.`;
    return `${it}${later} This cannot be undone.`;
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
                    body={cancelText(send)}
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
            <>
                <Badge status="success" role="status">
                    Sent
                </Badge>
                {hasTracking(send.tracking) && (
                    <span className="text-xs text-text-muted">{trackingText(send.tracking)}</span>
                )}
            </>
        );
    }
    return (
        <Badge status="neutral" role="status">
            Sending…
        </Badge>
    );
}

/** The words a draft's line on the record's activity starts with. */
export function draftAction(draft: Pick<MailDraftView, 'content'>): string {
    const text = asWritten(draft.content.subject ?? '');
    return text ? `started a draft “${text}”` : 'started a draft';
}

/** Whether a draft is the one this record page's own composer opens with. */
export function draftIsHere(draft: Pick<MailDraftView, 'personId' | 'dealId'>, target: RecordTarget): boolean {
    return target.type === 'opportunity'
        ? draft.dealId === target.id
        : target.type === 'person' && draft.personId === target.id && draft.dealId === null;
}

/**
 * A draft under its line on the record's activity — the caller's own (no one else sees it): marked a draft, and
 * where it is written — in this page's composer, or on its deal's or person's page, a link away.
 */
export function DraftStatus({
    workspaceId,
    draft,
    target,
}: {
    workspaceId: string;
    draft: Pick<MailDraftView, 'personId' | 'dealId'>;
    target: RecordTarget;
}) {
    return (
        <>
            <Badge status="info">Draft</Badge>
            {draftIsHere(draft, target) ? (
                <span className="text-xs text-text-muted">In the email box above</span>
            ) : (
                <Link
                    to={
                        draft.dealId ? paths.deal(workspaceId, draft.dealId) : paths.person(workspaceId, draft.personId)
                    }
                    className={cn('text-xs text-accent underline', focusRing)}
                >
                    {draft.dealId ? 'Open on its deal' : 'Open on the person'}
                </Link>
            )}
        </>
    );
}
