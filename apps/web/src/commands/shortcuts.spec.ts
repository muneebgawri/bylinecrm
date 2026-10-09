import { describe, expect, it, vi } from 'vitest';
import { CHORD_TIMEOUT_MS, createShortcutMatcher, formatShortcut, tokenOf, type KeyLike } from './shortcuts';

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    ...extra,
});

describe('tokenOf', () => {
    it('spells keys and modifiers in the grammar', () => {
        expect(tokenOf(key('k', { metaKey: true }))).toBe('mod+k');
        expect(tokenOf(key('K', { ctrlKey: true, shiftKey: true }))).toBe('mod+k');
        expect(tokenOf(key('?', { shiftKey: true }))).toBe('?');
        expect(tokenOf(key('Enter', { shiftKey: true }))).toBe('shift+enter');
    });
});

describe('createShortcutMatcher', () => {
    it('fires a single key and a modifier shortcut', () => {
        const palette = vi.fn();
        const help = vi.fn();
        const handle = createShortcutMatcher(() => [
            { shortcut: 'mod+k', run: palette },
            { shortcut: '?', run: help },
        ]);
        expect(handle(key('k', { metaKey: true }))).toBe(true);
        expect(handle(key('?'))).toBe(true);
        expect(handle(key('x'))).toBe(false);
        expect(palette).toHaveBeenCalledTimes(1);
        expect(help).toHaveBeenCalledTimes(1);
    });

    it('completes a chord pressed within the timeout and forgets it after', () => {
        let now = 0;
        const people = vi.fn();
        const handle = createShortcutMatcher(
            () => [{ shortcut: 'g p', run: people }],
            () => now,
        );
        expect(handle(key('g'))).toBe(true);
        now += CHORD_TIMEOUT_MS + 1;
        expect(handle(key('p'))).toBe(false);
        expect(people).not.toHaveBeenCalled();

        now = 5000;
        handle(key('g'));
        now += 200;
        expect(handle(key('p'))).toBe(true);
        expect(people).toHaveBeenCalledTimes(1);
    });

    it('ignores plain keys while typing in a field but still takes modifier shortcuts', () => {
        const input = document.createElement('input');
        const palette = vi.fn();
        const people = vi.fn();
        const handle = createShortcutMatcher(() => [
            { shortcut: 'mod+k', run: palette },
            { shortcut: 'g p', run: people },
        ]);
        expect(handle(key('g', { target: input }))).toBe(false);
        expect(handle(key('p', { target: input }))).toBe(false);
        expect(people).not.toHaveBeenCalled();
        expect(handle(key('k', { metaKey: true, target: input }))).toBe(true);
        expect(palette).toHaveBeenCalledTimes(1);
    });
});

describe('formatShortcut', () => {
    it('renders for the platform', () => {
        expect(formatShortcut('mod+k', 'MacIntel')).toBe('⌘K');
        expect(formatShortcut('mod+k', 'Win32')).toBe('Ctrl+K');
        expect(formatShortcut('g p', 'MacIntel')).toBe('G then P');
        expect(formatShortcut('shift+enter', 'Linux x86_64')).toBe('Shift+Enter');
    });
});
