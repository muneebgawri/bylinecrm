import type { RecordTarget } from '@bylinecrm/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { useOutboundMessages, useScheduledMail, useSessionSends, type SessionSend } from '../../../api/mail';
import type { MailOutboundView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';

/**
 * A send on a record's timeline before (or instead of) the stored message: going now ("Sending…"
 * → "Sent"), failed (with the reason and Retry), or scheduled (with Cancel and Reschedule).
 */
export interface PendingSend {
    messageId: string;
    subject: string;
    status: MailOutboundView['status'];
    sendAt: string | null;
    senderTimeZone: string | null;
    error: MailOutboundView['error'];
    /** The stored copy once sent; the timeline's own entry for it replaces this one. */
    mailMessageId: string | null;
    threadId: string | null;
    /** What was sent from this tab — what Retry sends again; null for a send scheduled elsewhere. */
    session: SessionSend | null;
}

/** Whether a send is about this record: its person, or the deal it was written from. */
function concerns(target: RecordTarget, send: { personId: string | null; dealId: string | null }): boolean {
    if (target.type === 'person') return send.personId === target.id;
    if (target.type === 'opportunity') return send.dealId === target.id;
    return false;
}

/**
 * The record's sends that are not (yet) a stored message on its timeline: this tab's, and the
 * scheduled ones the server holds (so a reload still shows "Scheduled for …"). Each is read back
 * until final (`outboundPollMs`). A sent one stays as "Sent" until the timeline carries the stored
 * message (`onTimeline`, the linked message ids it has); a cancelled one goes.
 */
export function usePendingSends(
    workspaceId: string,
    target: RecordTarget,
    onTimeline: ReadonlySet<string>,
): PendingSend[] {
    const canSend = useCan('email:send');
    const session = useSessionSends(workspaceId);
    const scheduled = useScheduledMail(workspaceId, canSend && target.type !== 'company');

    const mine = useMemo(() => (session.data ?? []).filter((s) => concerns(target, s)), [session.data, target]);
    const held = useMemo(
        () =>
            (scheduled.data?.items ?? []).filter((s) => concerns(target, s) && !mine.some((m) => m.messageId === s.id)),
        [scheduled.data, target, mine],
    );
    const ids = useMemo(() => [...mine.map((s) => s.messageId), ...held.map((s) => s.id)], [mine, held]);
    const statuses = useOutboundMessages(workspaceId, ids);

    const pending = useMemo(() => {
        const list: PendingSend[] = [];
        ids.forEach((id, i) => {
            const own = mine.find((s) => s.messageId === id) ?? null;
            const view = statuses[i]?.data ?? held.find((s) => s.id === id);
            const status = view?.status ?? own?.accepted.status ?? 'queued';
            if (status === 'cancelled') return;
            const mailMessageId = view?.mailMessageId ?? null;
            if (status === 'sent' && mailMessageId && onTimeline.has(mailMessageId)) return;
            list.push({
                messageId: id,
                subject: view?.subject || own?.subject || '',
                status,
                sendAt: view?.sendAt ?? own?.accepted.sendAt ?? null,
                senderTimeZone: view?.senderTimeZone ?? own?.accepted.senderTimeZone ?? null,
                error: view?.error ?? null,
                mailMessageId,
                threadId: view?.threadId ?? null,
                session: own,
            });
        });
        return list;
    }, [ids, mine, held, statuses, onTimeline]);

    // A send that has gone, and again once its copy is stored, is on the records it concerns: read
    // their timelines again (each step once per send).
    const client = useQueryClient();
    const seen = useRef(new Set<string>());
    useEffect(() => {
        const steps = pending
            .filter((p) => p.status === 'sent')
            .map((p) => `${p.messageId}:${p.mailMessageId ?? ''}`)
            .filter((step) => !seen.current.has(step));
        if (steps.length === 0) return;
        for (const step of steps) seen.current.add(step);
        void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline'] });
    }, [pending, client, workspaceId]);

    return pending;
}
