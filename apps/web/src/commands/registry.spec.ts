import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry, commands, useCommands, useRegisterCommands, type Command } from './registry';

const command = (id: string, extra: Partial<Command> = {}): Command => ({
    id,
    title: id,
    group: 'Test',
    run: () => undefined,
    ...extra,
});

describe('CommandRegistry', () => {
    it('registers, lists in order and unregisters through the returned cleanup', () => {
        const registry = new CommandRegistry();
        const off = registry.registerMany([command('a'), command('b')]);
        expect(registry.all().map((c) => c.id)).toEqual(['a', 'b']);
        off();
        expect(registry.all()).toEqual([]);
    });

    it('refuses a duplicate id', () => {
        const registry = new CommandRegistry();
        registry.register(command('a'));
        expect(() => registry.register(command('a'))).toThrow('already registered');
    });

    it('a stale cleanup does not remove a newer registration of the same id', () => {
        const registry = new CommandRegistry();
        const offOld = registry.register(command('a'));
        offOld();
        const fresh = command('a', { title: 'fresh' });
        registry.register(fresh);
        offOld();
        expect(registry.get('a')).toBe(fresh);
    });

    it('hides a command whose `when` is false from the available list but not from the catalogue', () => {
        const registry = new CommandRegistry();
        registry.register(command('hidden', { when: () => false }));
        registry.register(command('shown'));
        expect(registry.available().map((c) => c.id)).toEqual(['shown']);
        expect(registry.all().map((c) => c.id)).toEqual(['hidden', 'shown']);
    });

    it('notifies subscribers on change', () => {
        const registry = new CommandRegistry();
        const listener = vi.fn();
        const unsubscribe = registry.subscribe(listener);
        const off = registry.register(command('a'));
        off();
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
        registry.register(command('b'));
        expect(listener).toHaveBeenCalledTimes(2);
    });
});

describe('useRegisterCommands', () => {
    it('contributes commands while mounted and withdraws them on unmount', () => {
        const page = [command('page.action')];
        const { unmount } = renderHook(() => useRegisterCommands(page, []));
        expect(commands.get('page.action')).toBeDefined();
        unmount();
        expect(commands.get('page.action')).toBeUndefined();
    });

    it('re-registers when its dependencies change', () => {
        let id = 'ws-1';
        const { rerender, unmount } = renderHook(() =>
            useRegisterCommands([command('nav.people', { run: () => id })], [id]),
        );
        const first = commands.get('nav.people');
        id = 'ws-2';
        rerender();
        expect(commands.get('nav.people')).not.toBe(first);
        unmount();
    });

    it('exposes the live list to React', () => {
        const { result, unmount } = renderHook(() => useCommands());
        expect(result.current).toEqual([]);
        const off = commands.register(command('live'));
        expect(commands.all().map((c) => c.id)).toContain('live');
        off();
        unmount();
    });
});
