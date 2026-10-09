import { useEffect } from 'react';
import { commands, type CommandRegistry } from './registry';

/**
 * Keyboard shortcuts for the registry's commands. The grammar, once:
 *   - a key: `k`, `?`, `escape`
 *   - with modifiers: `mod+k` (`mod` is ⌘ on a Mac and Ctrl elsewhere), `shift+?`, `mod+shift+p`
 *   - a chord of keys pressed in sequence: `g p` (within `CHORD_TIMEOUT_MS` of each other)
 * Plain keys and chords are ignored while the person is typing in a field; modifier shortcuts
 * fire everywhere, because `mod+k` from inside a search box is the point.
 */
export const CHORD_TIMEOUT_MS = 1000;

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export interface KeyLike {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    target?: EventTarget | null;
}

/** One pressed key as a token in the grammar: `mod+k`, `g`, `?`. */
export function tokenOf(event: KeyLike): string {
    const parts: string[] = [];
    if (event.metaKey || event.ctrlKey) parts.push('mod');
    if (event.altKey) parts.push('alt');
    // Shift is part of the character for printable keys (`?` is already shifted `/`), so it is
    // only a modifier for non-printable ones.
    if (event.shiftKey && event.key.length > 1) parts.push('shift');
    parts.push(event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase());
    return parts.join('+');
}

export function isTyping(target: EventTarget | null | undefined): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return EDITABLE.has(target.tagName) || target.isContentEditable;
}

export interface Binding {
    shortcut: string;
    run: () => void;
}

/**
 * Matches key events against bindings, keeping the pending chord prefix between calls. Returns
 * true when an event was consumed (so the caller prevents the default).
 */
export function createShortcutMatcher(getBindings: () => readonly Binding[], now: () => number = Date.now) {
    let pending: string[] = [];
    let pendingAt = 0;

    return function handle(event: KeyLike): boolean {
        const token = tokenOf(event);
        const typing = isTyping(event.target);
        if (typing && !token.startsWith('mod+')) {
            pending = [];
            return false;
        }
        if (now() - pendingAt > CHORD_TIMEOUT_MS) pending = [];
        const sequence = [...pending, token];
        const bindings = getBindings();

        const exact = bindings.find((b) => b.shortcut.split(' ').join(' ') === sequence.join(' '));
        if (exact) {
            pending = [];
            exact.run();
            return true;
        }
        const prefix = sequence.join(' ') + ' ';
        if (bindings.some((b) => b.shortcut.startsWith(prefix))) {
            pending = sequence;
            pendingAt = now();
            return true;
        }
        pending = [];
        return false;
    };
}

/** Binds every available command's `shortcut` on `window` for the component's lifetime. */
export function useCommandShortcuts(registry: CommandRegistry = commands): void {
    useEffect(() => {
        const handle = createShortcutMatcher(() =>
            registry
                .available()
                .filter((c): c is typeof c & { shortcut: string } => Boolean(c.shortcut))
                .map((c) => ({ shortcut: c.shortcut, run: c.run })),
        );
        const onKeydown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) return;
            if (handle(event)) event.preventDefault();
        };
        window.addEventListener('keydown', onKeydown);
        return () => window.removeEventListener('keydown', onKeydown);
    }, [registry]);
}

/** Renders a shortcut for people: `mod+k` → `⌘K` on a Mac, `Ctrl+K` elsewhere; `g p` → `G then P`. */
export function formatShortcut(shortcut: string, platform: string = navigator.platform): string {
    const mac = /mac|iphone|ipad/i.test(platform);
    return shortcut
        .split(' ')
        .map((chord) =>
            chord
                .split('+')
                .map((part) => {
                    if (part === 'mod') return mac ? '⌘' : 'Ctrl';
                    if (part === 'shift') return mac ? '⇧' : 'Shift';
                    if (part === 'alt') return mac ? '⌥' : 'Alt';
                    return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
                })
                .join(mac ? '' : '+'),
        )
        .join(' then ');
}
