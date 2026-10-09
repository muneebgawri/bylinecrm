import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useRegisterCommands, type Command } from '../../../commands/registry';

/**
 * The record page's keyboard (FR-CRMS-UI-4): registered in the palette so `?` lists them and the
 * same key means the same thing on every record. `e` is honest about mail not existing yet.
 * Prev/next bind only while a list is known; `alt+[`/`alt+]` because the shell already owns `[`
 * for the sidebar.
 */
export function useRecordCommands(input: {
    recordId: string;
    onNote?: (() => void) | undefined;
    onTask?: (() => void) | undefined;
    onOwner?: (() => void) | undefined;
    onCompose?: (() => void) | undefined;
    prev?: string | null | undefined;
    next?: string | null | undefined;
}) {
    const navigate = useNavigate();
    const commands = useMemo<Command[]>(() => {
        const list: Command[] = [];
        if (input.onCompose) {
            list.push({
                id: 'record.compose',
                title: 'Write an email',
                group: 'This record',
                shortcut: 'e',
                run: input.onCompose,
            });
        }
        if (input.onNote)
            list.push({
                id: 'record.note',
                title: 'Add a note',
                group: 'This record',
                shortcut: 'n',
                run: input.onNote,
            });
        if (input.onTask)
            list.push({
                id: 'record.task',
                title: 'Add a task',
                group: 'This record',
                shortcut: 't',
                run: input.onTask,
            });
        if (input.onOwner)
            list.push({
                id: 'record.owner',
                title: 'Change owner',
                group: 'This record',
                shortcut: 'o',
                run: input.onOwner,
            });
        if (input.prev) {
            const to = input.prev;
            list.push({
                id: 'record.prev',
                title: 'Previous record',
                group: 'This record',
                shortcut: 'alt+[',
                run: () => navigate(to),
            });
        }
        if (input.next) {
            const to = input.next;
            list.push({
                id: 'record.next',
                title: 'Next record',
                group: 'This record',
                shortcut: 'alt+]',
                run: () => navigate(to),
            });
        }
        return list;
    }, [input.onCompose, input.onNote, input.onTask, input.onOwner, input.prev, input.next, navigate]);
    useRegisterCommands(commands, [commands]);
}
