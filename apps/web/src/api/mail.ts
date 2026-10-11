import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { query, workspacePath } from './endpoints';
import { keys } from './queries';
import type { RecordTarget } from '@bylinecrm/shared';
import type {
    MailOutboundView,
    MailRecordSendsPage,
    MailSendAcceptedView,
    MailThreadView,
    RescheduleMailInput,
    SendMailInput,
} from './types';

/**
 * Mail on a record (P2-UI-1): sending, following a send, scheduling, and reading a thread. They
 * live apart from `queries.ts` so they load with the record pages, not with every page
 * (FR-CRMS-UI-10); their cache keys are in `keys` with every other. The endpoints are here too, for
 * the same reason (the first-load budget, FR-CRMS-UI-10).
 */

/**
 * Mail from a record (P2-3, P2-5): a send is accepted (`202`) and happens in a job, so its progress
 * is read back at `messages/:id`; a scheduled one can be moved or called off until it goes. Threads
 * are what sync stored (P2-2): bodies only for the owner of a personal mailbox, metadata otherwise.
 */
export const mail = {
    send: (workspaceId: string, input: SendMailInput) =>
        request<MailSendAcceptedView>('POST', workspacePath(workspaceId, '/mail/send'), { body: input }),
    message: (workspaceId: string, messageId: string, signal?: AbortSignal) =>
        request<MailOutboundView>('GET', workspacePath(workspaceId, `/mail/messages/${messageId}`), { signal }),
    reschedule: (workspaceId: string, messageId: string, input: RescheduleMailInput) =>
        request<MailOutboundView>('PATCH', workspacePath(workspaceId, `/mail/messages/${messageId}`), { body: input }),
    cancel: (workspaceId: string, messageId: string) =>
        request<MailOutboundView>('POST', workspacePath(workspaceId, `/mail/messages/${messageId}/cancel`)),
    /**
     * One record's sends in the statuses asked for, newest first, a page at a time (#104): only the
     * ones the caller may see (their own; an admin's: everyone's).
     */
    recordSends: (
        workspaceId: string,
        params: {
            target: RecordTarget;
            status: readonly MailOutboundView['status'][];
            limit: number;
            cursor?: string | undefined;
        },
        signal?: AbortSignal,
    ) =>
        request<MailRecordSendsPage>(
            'GET',
            workspacePath(
                workspaceId,
                `/mail/messages${query({
                    target: `${params.target.type}:${params.target.id}`,
                    status: params.status.join(','),
                    limit: params.limit,
                    cursor: params.cursor,
                })}`,
            ),
            { signal },
        ),
    thread: (workspaceId: string, threadId: string, signal?: AbortSignal) =>
        request<MailThreadView>('GET', workspacePath(workspaceId, `/mail/threads/${threadId}`), { signal }),
};

/** How many of a record's sends one page holds. */
export const MAIL_RECORD_SENDS_PAGE = 25;
/** The sends a record page shows besides its stored mail: failed (with the reason) and scheduled. */
export const RECORD_SEND_STATUSES = ['failed', 'scheduled'] as const satisfies readonly MailOutboundView['status'][];

/**
 * A send made in this tab. The server answers `202` before anything is stored on a record, so the
 * client keeps what it sent — to show it on the timeline at once, and to send it again on Retry.
 */
export interface SessionSend {
    messageId: string;
    personId: string;
    dealId: string | null;
    /** The subject as written (variables as `{{path}}`), for the timeline line. */
    subject: string;
    input: SendMailInput;
    accepted: MailSendAcceptedView;
}

const POLL_FIRST_MS = 1_000;
const POLL_MAX_MS = 15_000;
const SCHEDULED_POLL_MIN_MS = 5_000;
const SCHEDULED_POLL_MAX_MS = 5 * 60_000;

/**
 * How long until a send's status is read again. A send going now is read with backoff — 1s, 2s,
 * 4s … up to 15s — until it is final and, once sent, until its stored copy exists (the timeline
 * entry is that copy); a scheduled one shortly after its time (at most every five minutes, so a
 * reschedule elsewhere is seen); a failed or cancelled one never.
 */
export function outboundPollMs(
    view: Pick<MailOutboundView, 'status' | 'sendAt' | 'mailMessageId'> | undefined,
    reads: number,
    now: number,
): number | false {
    if (view?.status === 'failed' || view?.status === 'cancelled') return false;
    if (view?.status === 'sent' && view.mailMessageId !== null) return false;
    if (view?.status === 'scheduled' && view.sendAt) {
        const until = Date.parse(view.sendAt) - now;
        return Math.min(Math.max(until, SCHEDULED_POLL_MIN_MS), SCHEDULED_POLL_MAX_MS);
    }
    return Math.min(POLL_FIRST_MS * 2 ** Math.max(reads - 1, 0), POLL_MAX_MS);
}

/** This tab's sends; never fetched — the composer adds to it, Retry replaces in it. */
export const useSessionSends = (workspaceId: string) =>
    useQuery({
        queryKey: keys.mailSession(workspaceId),
        queryFn: () => [] as SessionSend[],
        staleTime: Infinity,
        gcTime: Infinity,
    });

/** Every send's status, read until it is final (`outboundPollMs`). */
export function useOutboundMessages(workspaceId: string, messageIds: readonly string[]) {
    return useQueries({
        queries: messageIds.map((id) => ({
            queryKey: keys.mailMessage(workspaceId, id),
            queryFn: ({ signal }: { signal: AbortSignal }) => mail.message(workspaceId, id, signal),
            refetchInterval: (query: { state: { data: MailOutboundView | undefined; dataUpdateCount: number } }) =>
                outboundPollMs(query.state.data, query.state.dataUpdateCount, Date.now()),
            // A send's outcome matters when the person comes back to the tab, not only while they watch it;
            // the backoff and the final states bound the reads either way.
            refetchIntervalInBackground: true,
        })),
    });
}

/**
 * A record's failed and scheduled sends from the server (#104), newest first, a page at a time —
 * so a reload still shows a failure with its reason, and a scheduled send with its time. Anyone who
 * can read the record sees them (#133), whether or not they may send mail.
 */
export const useRecordSends = (workspaceId: string, target: RecordTarget) =>
    useInfiniteQuery({
        queryKey: keys.mailRecordSends(workspaceId, target),
        queryFn: ({ pageParam, signal }) =>
            mail.recordSends(
                workspaceId,
                { target, status: RECORD_SEND_STATUSES, limit: MAIL_RECORD_SENDS_PAGE, cursor: pageParam },
                signal,
            ),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
    });

/**
 * Sends (or schedules) one message. On `202` the send joins this tab's list — replacing the one it
 * retries, when it is a retry — so the timeline shows it before the server has stored anything.
 */
export function useSendMail(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: { send: SendMailInput; subject: string; replaces?: string | undefined }) =>
            mail.send(workspaceId, input.send),
        onSuccess: (accepted, input) => {
            const entry: SessionSend = {
                messageId: accepted.messageId,
                personId: input.send.personId,
                dealId: input.send.dealId ?? null,
                subject: input.subject,
                input: input.send,
                accepted,
            };
            client.setQueryData<SessionSend[]>(keys.mailSession(workspaceId), (list = []) => [
                entry,
                ...list.filter((s) => s.messageId !== input.replaces),
            ]);
            if (accepted.status === 'scheduled') {
                void client.invalidateQueries({ queryKey: keys.mailRecordSendsAll(workspaceId) });
            }
        },
    });
}

/** A reschedule or a cancel answers with the send as it now stands: that is what the timeline shows. */
function useOutboundWrite<I>(workspaceId: string, write: (input: I) => Promise<MailOutboundView>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: write,
        onSuccess: (view) => {
            client.setQueryData(keys.mailMessage(workspaceId, view.id), view);
            return client.invalidateQueries({ queryKey: keys.mailRecordSendsAll(workspaceId) });
        },
    });
}

export const useRescheduleMail = (workspaceId: string) =>
    useOutboundWrite(workspaceId, (input: { messageId: string; reschedule: RescheduleMailInput }) =>
        mail.reschedule(workspaceId, input.messageId, input.reschedule),
    );
export const useCancelMail = (workspaceId: string) =>
    useOutboundWrite(workspaceId, (messageId: string) => mail.cancel(workspaceId, messageId));

export const useMailThread = (workspaceId: string, threadId: string) =>
    useQuery({
        queryKey: keys.mailThread(workspaceId, threadId),
        queryFn: ({ signal }) => mail.thread(workspaceId, threadId, signal),
        enabled: threadId !== '',
    });
