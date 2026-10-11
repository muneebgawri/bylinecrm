import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Extension, InputRule, Node, mergeAttributes, type Editor } from '@tiptap/react';

/**
 * A template variable inside rich text: an inline, indivisible chip that stores only its path
 * (`{ type: 'variable', attrs: { path: 'person.firstName' } }` — the node P2-4's API validates and
 * renders). It is never text, so it cannot be half-deleted or mistyped (doc 50 §C).
 *
 * Typing `{{` does not insert anything: it removes the braces and asks the editor's owner to open
 * the variable picker at that place (`VARIABLE_TRIGGER_EVENT`), so a variable always comes from the registry.
 */
export const VARIABLE_NODE = 'variable';

/**
 * The editor event `{{` raises (the braces are already gone and the caret is where they were). The
 * editor's owner subscribes to it like any other editor event, so nothing is rebuilt or mutated
 * when the owner's callback changes.
 */
export const VARIABLE_TRIGGER_EVENT = 'variableTrigger';

declare module '@tiptap/react' {
    interface EditorEvents {
        variableTrigger: { editor: Editor };
    }
    interface Commands<ReturnType> {
        variable: {
            /**
             * Inserts a variable chip at the selection, replacing it, and leaves the caret right after
             * it. No space is added: what follows is the writer's (a comma, a full stop, a space), so
             * "Hi {{first name}}," never goes out as "Hi Dana ," (#108).
             */
            insertVariable: (path: string) => ReturnType;
        };
    }
}

export interface VariableOptions {
    /**
     * Whether `{{` asks for the picker. Off for an editor whose owner offers no picker (the record
     * composer: its variables come from a template), so the braces are just typed.
     */
    trigger: boolean;
}

export const Variable = Node.create<VariableOptions>({
    name: VARIABLE_NODE,
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    draggable: false,

    addOptions() {
        return { trigger: true };
    },

    addAttributes() {
        return {
            path: {
                default: '',
                parseHTML: (element) => element.getAttribute('data-variable') ?? '',
                renderHTML: (attributes: { path: string }) => ({ 'data-variable': attributes.path }),
            },
        };
    },

    parseHTML() {
        return [{ tag: 'span[data-variable]' }];
    },

    renderHTML({ node, HTMLAttributes }) {
        return [
            'span',
            mergeAttributes(HTMLAttributes, {
                class: 'variable-chip',
                contenteditable: 'false',
                'aria-label': `Variable ${String(node.attrs.path)}`,
            }),
            String(node.attrs.path),
        ];
    },

    renderText({ node }) {
        return `{{${String(node.attrs.path)}}}`;
    },

    addCommands() {
        return {
            insertVariable:
                (path: string) =>
                ({ chain }) =>
                    chain().insertContent({ type: VARIABLE_NODE, attrs: { path } }).run(),
        };
    },

    addInputRules() {
        if (!this.options.trigger) return [];
        return [
            new InputRule({
                find: /\{\{$/,
                handler: ({ state, range }) => {
                    state.tr.delete(range.from, range.to);
                    this.editor.emit(VARIABLE_TRIGGER_EVENT, { editor: this.editor });
                },
            }),
        ];
    },
});

/**
 * Marks the chips whose variable has no value for the person the text is going to (the API's
 * preview names them, FR-CRMS-3): red, and named as empty to a screen reader. It is a decoration,
 * never part of the document, so nothing about it is stored or sent.
 */
export const missingVariablesKey = new PluginKey<ReadonlySet<string>>('missingVariables');

export const MissingVariables = Extension.create({
    name: 'missingVariables',
    addProseMirrorPlugins() {
        return [
            new Plugin<ReadonlySet<string>>({
                key: missingVariablesKey,
                state: {
                    init: () => new Set<string>(),
                    apply: (tr, value) => (tr.getMeta(missingVariablesKey) as ReadonlySet<string> | undefined) ?? value,
                },
                props: {
                    decorations(state) {
                        const missing = missingVariablesKey.getState(state);
                        if (!missing || missing.size === 0) return null;
                        const marks: Decoration[] = [];
                        state.doc.descendants((node, pos) => {
                            const path = node.type.name === VARIABLE_NODE ? String(node.attrs.path) : null;
                            if (path && missing.has(path)) {
                                marks.push(
                                    Decoration.node(pos, pos + node.nodeSize, {
                                        class: 'variable-chip-missing',
                                        'aria-label': `Variable ${path}, empty for this person`,
                                    }),
                                );
                            }
                        });
                        return DecorationSet.create(state.doc, marks);
                    },
                },
            }),
        ];
    },
});
