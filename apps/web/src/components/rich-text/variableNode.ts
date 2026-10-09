import { InputRule, Node, mergeAttributes, type Editor } from '@tiptap/react';

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
            /** Inserts a variable chip at the selection, replacing it. */
            insertVariable: (path: string) => ReturnType;
        };
    }
}

export const Variable = Node.create({
    name: VARIABLE_NODE,
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    draggable: false,

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
                    chain()
                        .insertContent([
                            { type: VARIABLE_NODE, attrs: { path } },
                            { type: 'text', text: ' ' },
                        ])
                        .run(),
        };
    },

    addInputRules() {
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
