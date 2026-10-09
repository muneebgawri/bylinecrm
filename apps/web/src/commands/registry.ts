import { useEffect, useSyncExternalStore } from 'react';

/**
 * The command palette's registry (FR-CRMS-UI-4). Pages contribute commands while mounted and
 * withdraw them on unmount; the palette and the shortcuts sheet read one list. An id is unique:
 * registering it twice is a programming error, not a silent override.
 */
export interface Command {
    /** Stable, namespaced: `nav.people`, `theme.toggle`. */
    id: string;
    title: string;
    /** The heading the palette groups it under: `Go to`, `Workspace`, `Account`, … */
    group: string;
    /** In the shortcut grammar of `shortcuts.ts`: `mod+k`, `g p`, `?`. Shown and bound. */
    shortcut?: string;
    /** Extra words the palette's search matches. */
    keywords?: readonly string[];
    /** Omit the command (from the palette and the key binding) when this returns false. */
    when?: () => boolean;
    run: () => void;
}

type Listener = () => void;

export class CommandRegistry {
    private readonly commands = new Map<string, Command>();
    private readonly listeners = new Set<Listener>();
    private snapshot: readonly Command[] = [];

    register(command: Command): () => void {
        if (this.commands.has(command.id)) throw new Error(`command "${command.id}" is already registered`);
        this.commands.set(command.id, command);
        this.changed();
        return () => {
            // Only the registration that added it may remove it; a stale cleanup is a no-op.
            if (this.commands.get(command.id) === command) {
                this.commands.delete(command.id);
                this.changed();
            }
        };
    }

    registerMany(commands: readonly Command[]): () => void {
        const cleanups = commands.map((c) => this.register(c));
        return () => cleanups.forEach((cleanup) => cleanup());
    }

    get(id: string): Command | undefined {
        return this.commands.get(id);
    }

    /** Every registered command, in registration order, including those whose `when` is false. */
    all(): readonly Command[] {
        return this.snapshot;
    }

    /** The commands that apply right now. */
    available(): Command[] {
        return this.snapshot.filter((c) => c.when?.() ?? true);
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private changed(): void {
        this.snapshot = [...this.commands.values()];
        this.listeners.forEach((listener) => listener());
    }
}

/** The app's registry. One instance; the palette, the sheet and the key handler share it. */
export const commands = new CommandRegistry();

/**
 * Registers `list` for the component's lifetime. `deps` says when the list was rebuilt (a
 * command that closes over a workspace id re-registers when the id changes).
 */
export function useRegisterCommands(list: readonly Command[], deps: readonly unknown[]): void {
    // The list is rebuilt by the caller when `deps` change; depending on `list` itself would
    // re-register on every render because it is a fresh array each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => commands.registerMany(list), deps);
}

/** The registry's current contents, re-rendering on change. */
export function useCommands(registry: CommandRegistry = commands): readonly Command[] {
    return useSyncExternalStore(
        (listener) => registry.subscribe(listener),
        () => registry.all(),
        () => registry.all(),
    );
}
