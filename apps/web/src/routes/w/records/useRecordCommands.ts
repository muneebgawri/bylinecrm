import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useRegisterCommands, type Command } from '../../../commands/registry';
import { OPEN_PARAM } from './targets';

/**
 * The record's keyboard (FR-CRMS-UI-4): registered in the palette so `?` lists them and the same
 * key means the same thing on every record. `e` writes an email (the palette names whom: "Email
 * this person"); a record with no compose box registers no `e`. Prev/next
 * bind only while a list is known; `alt+[`/`alt+]` because the shell already owns `[` for the
 * sidebar.
 *
 * **One record answers at a time.** A drawer can open over a record page; the drawer is then the
 * record in front, so the page withdraws its commands while `?open=` is set and the drawer
 * registers its own under a separate id namespace. Two records never hold the same key.
 */
export function useRecordCommands(input: {
    layout: 'page' | 'drawer';
    onNote?: (() => void) | undefined;
    onTask?: (() => void) | undefined;
    onOwner?: (() => void) | undefined;
    onCompose?: (() => void) | undefined;
    /** The compose command's palette title ("Email this person"). */
    composeTitle?: string | undefined;
    prev?: string | null | undefined;
    next?: string | null | undefined;
}) {
    const navigate = useNavigate();
    const drawerOpen = new URLSearchParams(useLocation().search).has(OPEN_PARAM);
    const active = input.layout === 'drawer' || !drawerOpen;
    const ns = input.layout === 'drawer' ? 'drawer' : 'record';

    const commands = useMemo<Command[]>(() => {
        if (!active) return [];
        const group = input.layout === 'drawer' ? 'This panel' : 'This record';
        const list: Command[] = [];
        const add = (id: string, title: string, shortcut: string, run: () => void) =>
            list.push({ id: `${ns}.${id}`, title, group, shortcut, run });
        if (input.onCompose) add('compose', input.composeTitle ?? 'Write an email', 'e', input.onCompose);
        if (input.onNote) add('note', 'Add a note', 'n', input.onNote);
        if (input.onTask) add('task', 'Add a task', 't', input.onTask);
        if (input.onOwner) add('owner', 'Change owner', 'o', input.onOwner);
        const prev = input.prev;
        const next = input.next;
        if (prev) add('prev', 'Previous record', 'alt+[', () => navigate(prev));
        if (next) add('next', 'Next record', 'alt+]', () => navigate(next));
        return list;
    }, [
        active,
        ns,
        input.layout,
        input.onCompose,
        input.composeTitle,
        input.onNote,
        input.onTask,
        input.onOwner,
        input.prev,
        input.next,
        navigate,
    ]);
    useRegisterCommands(commands, [commands]);
}
