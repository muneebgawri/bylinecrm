import { useMutationState, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import { discardDraftKey, mail, useDiscardDraft } from '../../../api/mail';
import { keys } from '../../../api/queries';
import type { MailDraftContent, MailDraftPage, MailDraftView } from '../../../api/types';

/** How long after the last change the composer saves its draft: typing is not a save per key. */
export const DRAFT_SAVE_DELAY_MS = 2_000;

/**
 * Where the draft stands, for the composer's chip: nothing saved yet, saving, saved (and when), a save that
 * failed (it is tried again on the next change), or another tab's save in the way (`conflict`).
 */
export type DraftSaveState =
    | { kind: 'none' }
    | { kind: 'saving' }
    | { kind: 'saved'; at: string }
    | { kind: 'failed' }
    | { kind: 'conflict'; theirs: MailDraftView };

export interface DraftSaver {
    state: DraftSaveState;
    /** The saved draft's id, once there is one. */
    draftId: () => string | null;
    /** The composer changed: saved `DRAFT_SAVE_DELAY_MS` after the last change. */
    change: (content: MailDraftContent) => void;
    /** Saves the last change now (leaving the composer, closing the tab). */
    flush: (options?: { keepalive?: boolean }) => Promise<void>;
    /**
     * Before a send: drops a save not made yet (the send takes the composer's content, and deletes the draft) and
     * waits for one under way — so no save lands after the send to bring the draft back. The draft's id after.
     */
    settle: () => Promise<string | null>;
    /** After a send: the draft went with it; the next change starts a new one. */
    sent: () => void;
    /** Discards the draft — the one discard (`useDiscardDraft`) the record's activity uses too. */
    discard: () => Promise<void>;
    /** In a conflict: keep this composer's content, saved over the other tab's version. */
    keepMine: () => Promise<void>;
    /** In a conflict, or to stop saving before the composer is replaced: drops what is not saved yet. */
    abandon: () => void;
}

/**
 * The composer's draft, saved as the member writes (FR: drafts): a moment after the last change, at once when the
 * composer closes or the page is hidden (a request that outlives the page), and never twice at once — saves go
 * one after another, the last content winning. Each save names the version it replaces; when another tab saved
 * first (`409`), saving stops and the composer asks: load theirs, or keep this one. A draft gone meanwhile in
 * another tab (sent or discarded there) is written again from what this composer holds — it is the member's text.
 * A draft discarded in this tab — here, or from the record's activity — is gone for this composer too: it stops
 * saving it and tells the composer (`onDiscarded`), which empties.
 *
 * A reply's draft (`replyToMessageId`) is one of the same: keyed by the message it answers.
 */
export function useDraftSaver({
    workspaceId,
    personId,
    dealId,
    replyToMessageId,
    initial,
    onDiscarded,
}: {
    workspaceId: string;
    personId: string;
    dealId: string | undefined;
    replyToMessageId?: string | undefined;
    initial: MailDraftView | null;
    onDiscarded?: (() => void) | undefined;
}): DraftSaver {
    const client = useQueryClient();
    const discarding = useDiscardDraft(workspaceId);
    // Every draft discarded in this tab, by whatever discarded it: the one signal a composer and the activity share.
    const discardedIds = useMutationState({
        filters: { mutationKey: discardDraftKey(workspaceId), status: 'success' },
        select: (m) => m.state.variables as string,
    });
    const discarded = useRef(new Set<string>());
    const saved = useRef<{ id: string; version: number } | null>(
        initial ? { id: initial.id, version: initial.version } : null,
    );
    const savedJson = useRef<string | null>(initial ? JSON.stringify(initial.content) : null);
    // The latest content asked to be saved and not yet sent to the API; and the last one wanted at all.
    const pending = useRef<MailDraftContent | null>(null);
    const latest = useRef<MailDraftContent | null>(initial?.content ?? null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const chain = useRef<Promise<void>>(Promise.resolve());
    const conflicted = useRef(false);
    const [state, setState] = useState<DraftSaveState>(
        initial ? { kind: 'saved', at: initial.updatedAt } : { kind: 'none' },
    );

    // The person's list is what this composer opens from: kept current at once, so closing and reopening it shows
    // the draft just saved; every record's list (a deal's, a company's, the activity) is read again after.
    const refreshLists = useCallback(
        (view: MailDraftView) => {
            client.setQueryData<MailDraftPage>(
                keys.mailDrafts(workspaceId, { type: 'person', id: personId }),
                (page) => page && { ...page, items: [view, ...page.items.filter((d) => d.id !== view.id)] },
            );
            return client.invalidateQueries({ queryKey: keys.mailDraftsAll(workspaceId) });
        },
        [client, workspaceId, personId],
    );

    // Which composer the draft is: the person's (and deal's), or a reply to one message.
    const key = useMemo(
        () => ({ personId, dealId, ...(replyToMessageId ? { replyToMessageId } : {}) }),
        [personId, dealId, replyToMessageId],
    );

    const write = useCallback(
        async (content: MailDraftContent, keepalive: boolean): Promise<void> => {
            if (conflicted.current) return;
            const json = JSON.stringify(content);
            if (json === savedJson.current) return;
            setState({ kind: 'saving' });
            try {
                let view: MailDraftView;
                const current = saved.current;
                if (current) {
                    try {
                        view = await mail.saveDraft(
                            workspaceId,
                            current.id,
                            { version: current.version, content },
                            { keepalive },
                        );
                    } catch (error) {
                        if (!(error instanceof ApiError) || error.status !== 404) throw error;
                        // Discarded in this tab while this save was under way: it stays discarded.
                        if (discarded.current.has(current.id)) return;
                        // Gone meanwhile (sent or discarded in another tab): this composer's text is kept anew.
                        saved.current = null;
                        view = await mail.createDraft(workspaceId, { ...key, content }, { keepalive });
                    }
                } else {
                    view = await mail.createDraft(workspaceId, { ...key, content }, { keepalive });
                }
                saved.current = { id: view.id, version: view.version };
                savedJson.current = json;
                setState({ kind: 'saved', at: view.updatedAt });
                void refreshLists(view);
            } catch (error) {
                if (error instanceof ApiError && error.status === 409) {
                    // Another tab saved first (or started this composer's draft): show theirs, save nothing more.
                    const theirsId = typeof error.details['draftId'] === 'string' ? error.details['draftId'] : null;
                    const theirs = theirsId ? await mail.draft(workspaceId, theirsId).catch(() => null) : null;
                    if (theirs) {
                        conflicted.current = true;
                        setState({ kind: 'conflict', theirs });
                        return;
                    }
                }
                setState({ kind: 'failed' });
            }
        },
        [workspaceId, key, refreshLists],
    );

    const flush = useCallback(
        (options: { keepalive?: boolean } = {}) => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            const content = pending.current;
            pending.current = null;
            if (content) chain.current = chain.current.then(() => write(content, options.keepalive ?? false));
            return chain.current;
        },
        [write],
    );

    const change = useCallback(
        (content: MailDraftContent) => {
            latest.current = content;
            pending.current = content;
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => void flush(), DRAFT_SAVE_DELAY_MS);
        },
        [flush],
    );

    const abandon = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        pending.current = null;
    }, []);

    const settle = useCallback(async () => {
        abandon();
        await chain.current;
        return saved.current?.id ?? null;
    }, [abandon]);

    const sent = useCallback(() => {
        abandon();
        saved.current = null;
        savedJson.current = null;
        latest.current = null;
        conflicted.current = false;
        setState({ kind: 'none' });
    }, [abandon]);

    const discardAsync = discarding.mutateAsync;
    const discard = useCallback(async () => {
        const id = await settle();
        if (id) await discardAsync(id);
        sent();
    }, [settle, sent, discardAsync]);

    // A discard of this composer's draft from elsewhere in the tab (the record's activity): nothing more is saved
    // of it, and the composer empties.
    const notify = useRef(onDiscarded);
    useEffect(() => {
        notify.current = onDiscarded;
    });
    useEffect(() => {
        for (const id of discardedIds) discarded.current.add(id);
        const id = saved.current?.id;
        if (!id || !discarded.current.has(id)) return;
        sent();
        notify.current?.();
    }, [discardedIds, sent]);

    const keepMine = useCallback(async () => {
        if (state.kind !== 'conflict') return;
        saved.current = { id: state.theirs.id, version: state.theirs.version };
        savedJson.current = JSON.stringify(state.theirs.content);
        conflicted.current = false;
        pending.current = latest.current;
        await flush();
    }, [state, flush]);

    // Leaving the composer (the panel closes, the page changes) saves what is not saved yet; so does hiding the
    // page (the tab closing, the phone switching apps), with a request that outlives it.
    useEffect(() => {
        const hide = () => void flush({ keepalive: true });
        window.addEventListener('pagehide', hide);
        return () => {
            window.removeEventListener('pagehide', hide);
            void flush({ keepalive: true });
        };
    }, [flush]);

    return {
        state,
        draftId: () => saved.current?.id ?? null,
        change,
        flush,
        settle,
        sent,
        discard,
        keepMine,
        abandon,
    };
}
