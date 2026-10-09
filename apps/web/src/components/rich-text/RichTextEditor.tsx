import type { RichText } from '@bylinecrm/shared';
import { Button, cn, focusRing } from '@bylinecrm/ui';
import Link from '@tiptap/extension-link';
import { EditorContent, Node, useEditor, type AnyExtension, type Editor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Heading2, Heading3, Italic, Link2, List, ListOrdered } from 'lucide-react';
import { useEffect, useImperativeHandle, useState, type Ref } from 'react';
import { VARIABLE_TRIGGER_EVENT, Variable } from './variableNode';

/**
 * The product's one rich-text editor (Tiptap). Notes, task bodies, template bodies and template
 * subjects are the same editor with a different **profile** — what it may contain, which tools
 * the toolbar offers and which link schemes it accepts — so a fix to the editor is a fix
 * everywhere and nothing stores what its viewer or the API cannot handle.
 *
 * - `note`: headings, bold, italic, lists, http(s) links (what `RichTextView` shows).
 * - `template`: exactly the API's template subset (P2-4: paragraphs, h2/h3, bold, italic, lists,
 *   line breaks, `https:`/`mailto:` links) plus variable chips.
 * - `subject`: one line of text and variable chips; no marks, no blocks.
 */
export type RichTextProfile = 'note' | 'template' | 'subject';

export interface RichTextHandle {
    /** Inserts a variable chip at the caret (template and subject profiles). */
    insertVariable: (path: string) => void;
    focus: () => void;
}

export interface RichTextEditorProps {
    profile: RichTextProfile;
    value: RichText;
    onChange: (value: RichText) => void;
    /** Focus the editor when it mounts (a new note). */
    autoFocus?: boolean;
    placeholder?: string;
    'aria-label': string;
    /** `{{` was typed: open the variable picker (template and subject profiles). */
    onVariableTrigger?: () => void;
    /** Told when the editor gains focus, so a shared "Insert variable" knows where to insert. */
    onFocus?: () => void;
    handle?: Ref<RichTextHandle>;
    readOnly?: boolean;
    className?: string;
}

type Tool = 'h2' | 'h3' | 'bold' | 'italic' | 'bulletList' | 'orderedList' | 'link';

interface ProfileSpec {
    tools: readonly Tool[];
    /** Schemes a link may use; `undefined` when the profile has no links. */
    linkSchemes?: readonly string[];
    singleLine: boolean;
    minHeightClass: string;
}

export const PROFILES: Record<RichTextProfile, ProfileSpec> = {
    note: {
        tools: ['h2', 'bold', 'italic', 'bulletList', 'orderedList', 'link'],
        linkSchemes: ['http', 'https'],
        singleLine: false,
        minHeightClass: 'min-h-24',
    },
    template: {
        tools: ['h2', 'h3', 'bold', 'italic', 'bulletList', 'orderedList', 'link'],
        linkSchemes: ['https', 'mailto'],
        singleLine: false,
        minHeightClass: 'min-h-48',
    },
    subject: { tools: [], singleLine: true, minHeightClass: '' },
};

/** A document with exactly one paragraph: the subject line. */
const SingleLineDocument = Node.create({ name: 'doc', topNode: true, content: 'paragraph' });

function extensionsFor(profile: RichTextProfile): AnyExtension[] {
    const spec = PROFILES[profile];
    const link = spec.linkSchemes
        ? [
              Link.configure({
                  openOnClick: false,
                  autolink: profile === 'note',
                  protocols: [...spec.linkSchemes],
                  isAllowedUri: (url) => spec.linkSchemes!.some((scheme) => url.startsWith(`${scheme}:`)),
              }),
          ]
        : [];
    if (profile === 'note') {
        return [
            StarterKit.configure({
                heading: { levels: [2, 3] },
                codeBlock: false,
                blockquote: false,
                horizontalRule: false,
                link: false,
            }),
            ...link,
        ];
    }
    if (profile === 'template') {
        return [
            StarterKit.configure({
                heading: { levels: [2, 3] },
                codeBlock: false,
                blockquote: false,
                horizontalRule: false,
                strike: false,
                code: false,
                underline: false,
                link: false,
            }),
            ...link,
            Variable,
        ];
    }
    return [
        StarterKit.configure({
            document: false,
            heading: false,
            bold: false,
            italic: false,
            strike: false,
            code: false,
            codeBlock: false,
            blockquote: false,
            bulletList: false,
            orderedList: false,
            listItem: false,
            listKeymap: false,
            hardBreak: false,
            horizontalRule: false,
            underline: false,
            link: false,
            trailingNode: false,
        }),
        SingleLineDocument,
        Variable,
    ];
}

const EMPTY: RichText = { type: 'doc', content: [{ type: 'paragraph' }] };

/** Whether a link the person typed may be stored under this profile. */
export function linkAllowed(profile: RichTextProfile, href: string): boolean {
    const schemes = PROFILES[profile].linkSchemes;
    if (!schemes) return false;
    return schemes.some(
        (scheme) =>
            (scheme === 'mailto' ? /^mailto:\S+@\S+$/ : /^https?:\/\/\S+$/).test(href) && href.startsWith(`${scheme}:`),
    );
}

export function RichTextEditor({
    profile,
    value,
    onChange,
    autoFocus,
    placeholder,
    'aria-label': label,
    onVariableTrigger,
    onFocus,
    handle,
    readOnly = false,
    className,
}: RichTextEditorProps) {
    const spec = PROFILES[profile];
    const editor = useEditor({
        extensions: extensionsFor(profile),
        content: (value.content?.length ? value : EMPTY) as JSONContent,
        autofocus: autoFocus ? 'end' : false,
        editable: !readOnly,
        editorProps: {
            attributes: {
                'aria-label': label,
                role: 'textbox',
                ...(spec.singleLine ? {} : { 'aria-multiline': 'true' }),
                class: cn(
                    'rich-text outline-none px-3 text-[13px] leading-relaxed max-md:text-touch',
                    spec.singleLine ? 'py-1.5 whitespace-nowrap overflow-x-auto' : `py-2 ${spec.minHeightClass}`,
                ),
            },
            // A subject is one line: Enter does nothing rather than splitting it.
            handleKeyDown: (_view, event) => spec.singleLine && event.key === 'Enter',
        },
        onUpdate: ({ editor: e }) => onChange(e.getJSON() as RichText),
        onFocus: () => onFocus?.(),
    });

    // `{{` asks the owner to open the variable picker; the latest callback is handed to the extension.
    useEffect(() => {
        if (!editor || !onVariableTrigger) return;
        const trigger = () => onVariableTrigger();
        editor.on(VARIABLE_TRIGGER_EVENT, trigger);
        return () => {
            editor.off(VARIABLE_TRIGGER_EVENT, trigger);
        };
    }, [editor, onVariableTrigger]);

    useImperativeHandle(
        handle,
        () => ({
            insertVariable: (path: string) => {
                editor?.chain().focus().insertVariable(path).run();
            },
            focus: () => {
                editor?.commands.focus();
            },
        }),
        [editor],
    );

    const [linkOpen, setLinkOpen] = useState(false);
    const [linkHref, setLinkHref] = useState('');
    const [linkError, setLinkError] = useState<string | null>(null);
    const [, rerender] = useState(0);
    useEffect(() => {
        if (!editor) return;
        const bump = () => rerender((n) => n + 1);
        editor.on('transaction', bump);
        return () => {
            editor.off('transaction', bump);
        };
    }, [editor]);

    if (!editor) return null;

    const setLink = () => {
        if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
            return;
        }
        setLinkOpen(true);
    };

    return (
        <div
            className={cn(
                'rounded-md border border-border bg-surface focus-within:border-border-strong',
                readOnly && 'bg-surface-raised',
                className,
            )}
        >
            {spec.tools.length > 0 && !readOnly && <Toolbar editor={editor} tools={spec.tools} onLink={setLink} />}
            {linkOpen && (
                <form
                    className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (!linkAllowed(profile, linkHref)) {
                            setLinkError(
                                profile === 'template'
                                    ? 'Use an https:// or mailto: address.'
                                    : 'Use an http:// or https:// address.',
                            );
                            return;
                        }
                        editor.chain().focus().setLink({ href: linkHref }).run();
                        setLinkOpen(false);
                        setLinkHref('');
                        setLinkError(null);
                    }}
                >
                    <input
                        autoFocus
                        type="text"
                        inputMode="url"
                        aria-label="Link address"
                        aria-invalid={linkError ? true : undefined}
                        placeholder={profile === 'template' ? 'https:// or mailto:' : 'https://'}
                        value={linkHref}
                        onChange={(e) => setLinkHref(e.target.value)}
                        className={cn(
                            'h-7 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-[13px] max-md:h-touch max-md:text-touch',
                            focusRing,
                        )}
                    />
                    <Button type="submit" size="xs" shape="square">
                        Link
                    </Button>
                    <Button
                        type="button"
                        size="xs"
                        shape="square"
                        variant="ghost"
                        onClick={() => {
                            setLinkOpen(false);
                            setLinkError(null);
                        }}
                    >
                        Cancel
                    </Button>
                    {linkError && (
                        <p role="alert" className="m-0 w-full text-xs text-danger">
                            {linkError}
                        </p>
                    )}
                </form>
            )}
            <div className="relative">
                <EditorContent editor={editor} />
                {editor.isEmpty && placeholder && (
                    <p
                        aria-hidden
                        className={cn(
                            'pointer-events-none absolute inset-x-0 top-0 m-0 px-3 text-[13px] text-text-faint max-md:text-touch',
                            spec.singleLine ? 'py-1.5' : 'py-2',
                        )}
                    >
                        {placeholder}
                    </p>
                )}
            </div>
        </div>
    );
}

const TOOLS: Record<
    Tool,
    { title: string; icon: React.ReactNode; active: (e: Editor) => boolean; run: (e: Editor) => void }
> = {
    h2: {
        title: 'Heading',
        icon: <Heading2 className="size-4" />,
        active: (e) => e.isActive('heading', { level: 2 }),
        run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    h3: {
        title: 'Subheading',
        icon: <Heading3 className="size-4" />,
        active: (e) => e.isActive('heading', { level: 3 }),
        run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    bold: {
        title: 'Bold',
        icon: <Bold className="size-4" />,
        active: (e) => e.isActive('bold'),
        run: (e) => e.chain().focus().toggleBold().run(),
    },
    italic: {
        title: 'Italic',
        icon: <Italic className="size-4" />,
        active: (e) => e.isActive('italic'),
        run: (e) => e.chain().focus().toggleItalic().run(),
    },
    bulletList: {
        title: 'Bulleted list',
        icon: <List className="size-4" />,
        active: (e) => e.isActive('bulletList'),
        run: (e) => e.chain().focus().toggleBulletList().run(),
    },
    orderedList: {
        title: 'Numbered list',
        icon: <ListOrdered className="size-4" />,
        active: (e) => e.isActive('orderedList'),
        run: (e) => e.chain().focus().toggleOrderedList().run(),
    },
    link: {
        title: 'Add link',
        icon: <Link2 className="size-4" />,
        active: (e) => e.isActive('link'),
        run: () => undefined,
    },
};

function Toolbar({ editor, tools, onLink }: { editor: Editor; tools: readonly Tool[]; onLink: () => void }) {
    return (
        // On a phone the toolbar scrolls inside itself; every button is a 44px target (FR-CRMS-UI-12).
        <div
            role="toolbar"
            aria-label="Formatting"
            className="flex items-center gap-0.5 overflow-x-auto border-b border-border px-1.5 py-1"
        >
            {tools.map((id) => {
                const tool = TOOLS[id];
                const isLink = id === 'link';
                const active = tool.active(editor);
                const title = isLink && active ? 'Remove link' : tool.title;
                const disabled = isLink && editor.state.selection.empty && !active;
                return (
                    <button
                        key={id}
                        type="button"
                        title={title}
                        aria-label={title}
                        aria-pressed={active}
                        disabled={disabled}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => (isLink ? onLink() : tool.run(editor))}
                        className={cn(
                            'grid size-7 shrink-0 place-items-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text disabled:opacity-40 max-md:size-touch',
                            active && 'bg-surface-raised text-text',
                            focusRing,
                        )}
                    >
                        {tool.icon}
                    </button>
                );
            })}
        </div>
    );
}
