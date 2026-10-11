import { Button, Skeleton } from '@bylinecrm/ui';
import { EyeOff, Paperclip, Reply } from 'lucide-react';
import { useState } from 'react';
import { useMailThread } from '../../../api/mail';
import { useRecord } from '../../../api/records';
import type { MailMessageView, MailThreadView } from '../../../api/types';
import { EmailFrame } from '../../../components/EmailFrame';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { personName } from '../records/PersonRecord';
import { Composer, type ComposerReply } from './Composer';
import { oldestFirst, recipientLines, replyPersonId, senderName } from './thread';

/** What a message in another member's personal mailbox shows instead of its body. */
export const BODY_HIDDEN = 'Body hidden — personal mailbox';

/**
 * A thread, oldest message first (doc 50 §A, FR-CRMS-4). A body the caller may read is the API's
 * sanitised HTML in a sandboxed frame that runs no script (`EmailFrame`); a message in another
 * member's personal mailbox is its subject and participants only. Reply answers the newest message
 * from the thread's own mailbox (the API's rule), to the person on the other side.
 */
export function ThreadView({ workspaceId, threadId }: { workspaceId: string; threadId: string }) {
    const thread = useMailThread(workspaceId, threadId);

    if (thread.isPending) {
        return (
            <div
                className="flex flex-col gap-3 px-5.5 py-5"
                role="status"
                aria-busy="true"
                aria-label="Loading the thread"
            >
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-40" />
            </div>
        );
    }
    if (thread.isError) {
        return (
            <div className="flex items-center gap-3 px-5.5 py-5 text-[13px] text-text-muted">
                <span>The thread could not be loaded: {failureText(thread.error)}</span>
                <Button size="xs" shape="square" className="ml-auto" onClick={() => void thread.refetch()}>
                    Retry
                </Button>
            </div>
        );
    }
    const messages = oldestFirst(thread.data.messages);
    return (
        <div className="flex flex-col gap-4 px-5.5 py-5">
            <p className="m-0 text-xs text-text-muted">
                {thread.data.messageCount} message{thread.data.messageCount === 1 ? '' : 's'} · last{' '}
                {formatDate(thread.data.lastMessageAt)}
            </p>
            <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Messages, oldest first">
                {messages.map((message) => (
                    <li key={message.id}>
                        <Message message={message} />
                    </li>
                ))}
            </ol>
            <ReplyArea workspaceId={workspaceId} thread={thread.data} newest={messages[messages.length - 1]} />
        </div>
    );
}

function Message({ message }: { message: MailMessageView }) {
    const visible = message.bodiesVisible;
    return (
        <article
            aria-label={`${senderName(message)}, ${formatDate(message.sentAt)}`}
            className="rounded-lg border border-border bg-surface"
        >
            <header className="flex flex-col gap-0.5 border-b border-border px-4 py-2.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                    <b className="text-[13px] font-semibold">{senderName(message)}</b>
                    <span className="text-xs text-text-muted">
                        {message.direction === 'inbound' ? 'wrote' : 'sent'}
                    </span>
                    <time dateTime={message.sentAt} className="ml-auto text-xs text-text-faint">
                        {formatDate(message.sentAt)}
                    </time>
                </div>
                <p className="m-0 text-[13px] font-medium">{message.subject || '(no subject)'}</p>
                {recipientLines(message).map((line) => (
                    <p key={line} className="m-0 text-xs break-words text-text-muted">
                        {line}
                    </p>
                ))}
            </header>
            <div className="p-2">
                {!visible ? (
                    <p className="m-0 flex items-center gap-2 px-2 py-2 text-[13px] text-text-muted">
                        <EyeOff aria-hidden className="size-4" />
                        {BODY_HIDDEN}
                    </p>
                ) : message.bodyHtml ? (
                    <EmailFrame
                        fit
                        html={message.bodyHtml}
                        title={`Message from ${senderName(message)}`}
                        className="border-0"
                    />
                ) : message.bodyText ? (
                    <p className="m-0 px-2 py-2 text-[13px] break-words whitespace-pre-wrap">{message.bodyText}</p>
                ) : (
                    <p className="m-0 px-2 py-2 text-[13px] text-text-faint">This message has no text.</p>
                )}
                {visible && message.bodyTruncated && (
                    <p className="m-0 px-2 pb-1 text-xs text-text-faint">
                        Long message: only its beginning is stored here.
                    </p>
                )}
                {message.hasAttachments && (
                    <p className="m-0 flex items-center gap-1.5 px-2 pb-1 text-xs text-text-muted">
                        <Paperclip aria-hidden className="size-3.5" />
                        Has attachments (open it in your mail app to see them)
                    </p>
                )}
            </div>
        </article>
    );
}

/** Reply to the newest message: offered when the caller can read the thread and the other side is a person. */
function ReplyArea({
    workspaceId,
    thread,
    newest,
}: {
    workspaceId: string;
    thread: MailThreadView;
    newest: MailMessageView | undefined;
}) {
    const [open, setOpen] = useState(false);
    const personId = newest ? replyPersonId(newest) : null;
    if (!newest) return null;
    if (!newest.bodiesVisible) {
        return (
            <p className="m-0 text-xs text-text-muted">
                Replies go from a mailbox the message is in; this one is only in another member’s.
            </p>
        );
    }
    if (!personId) {
        return (
            <p className="m-0 text-xs text-text-muted">
                The other side of this thread is not a person in the CRM, so it cannot be answered from here.
            </p>
        );
    }
    if (!open) {
        return (
            <div>
                <Button size="sm" shape="square" variant="secondary" onClick={() => setOpen(true)}>
                    <Reply aria-hidden />
                    Reply
                </Button>
            </div>
        );
    }
    return (
        <ReplyComposer
            workspaceId={workspaceId}
            personId={personId}
            reply={{ messageId: newest.id, mailboxIds: newest.mailboxIds, subject: thread.subject }}
            onClose={() => setOpen(false)}
        />
    );
}

function ReplyComposer({
    workspaceId,
    personId,
    reply,
    onClose,
}: {
    workspaceId: string;
    personId: string;
    reply: ComposerReply;
    onClose: () => void;
}) {
    const person = useRecord(workspaceId, 'person', personId);
    if (person.isPending) return <Skeleton className="h-40 rounded-lg" aria-label="Loading the reply" />;
    if (person.isError) {
        return (
            <p className="m-0 text-xs text-danger">
                The person this goes to could not be loaded: {failureText(person.error)}
            </p>
        );
    }
    return (
        <Composer
            workspaceId={workspaceId}
            person={{ id: person.data.id, name: personName(person.data), email: person.data.emails.primary }}
            reply={reply}
            autoFocus
            onSent={onClose}
            onDiscard={onClose}
        />
    );
}
