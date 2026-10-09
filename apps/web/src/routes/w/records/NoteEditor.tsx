import type { RichText } from '@bylinecrm/shared';
import { Button, cn, focusRing } from '@bylinecrm/ui';
import Link from '@tiptap/extension-link';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Heading2, Italic, Link2, List, ListOrdered } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * The rich-text editor for notes and task bodies — its own chunk, loaded when a person starts
 * writing (FR-CRMS-UI-10; it must not enter the initial bundle). Headings, bold, italic, lists
 * and links: nothing else, so what is stored is what `RichTextView` can show.
 */
export interface NoteEditorProps {
    value: RichText;
    onChange: (value: RichText) => void;
    /** Focus the editor when it mounts (a new note). */
    autoFocus?: boolean;
    placeholder?: string;
    'aria-label': string;
}

const EMPTY: RichText = { type: 'doc', content: [{ type: 'paragraph' }] };

export default function NoteEditor({ value, onChange, autoFocus, placeholder, 'aria-label': label }: NoteEditorProps) {
    const editor = useEditor({
        extensions: [
            StarterKit.configure({
                heading: { levels: [2, 3] },
                codeBlock: false,
                blockquote: false,
                horizontalRule: false,
            }),
            Link.configure({ openOnClick: false, autolink: true, protocols: ['http', 'https'] }),
        ],
        content: (value.content?.length ? value : EMPTY) as JSONContent,
        autofocus: autoFocus ? 'end' : false,
        editorProps: {
            attributes: { 'aria-label': label, class: 'outline-none min-h-24 px-3 py-2 text-[13px] leading-relaxed' },
        },
        onUpdate: ({ editor: e }) => onChange(e.getJSON() as RichText),
    });
    const [linkOpen, setLinkOpen] = useState(false);
    const [linkHref, setLinkHref] = useState('');
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

    const tool = (title: string, active: boolean, onClick: () => void, icon: React.ReactNode, disabled = false) => (
        <button
            type="button"
            title={title}
            aria-label={title}
            aria-pressed={active}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
            className={cn(
                'grid size-7 place-items-center rounded-md text-text-muted hover:bg-surface-raised hover:text-text disabled:opacity-40',
                active && 'bg-surface-raised text-text',
                focusRing,
            )}
        >
            {icon}
        </button>
    );

    // A link is set through the inline form below (a dialog's prompt would not show in every viewer).
    const setLink = () => {
        if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
            return;
        }
        setLinkOpen(true);
    };

    return (
        <div className="rounded-md border border-border bg-surface focus-within:border-border-strong">
            <div className="flex items-center gap-0.5 border-b border-border px-1.5 py-1">
                {tool(
                    'Heading',
                    editor.isActive('heading'),
                    () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
                    <Heading2 className="size-4" />,
                )}
                {tool(
                    'Bold',
                    editor.isActive('bold'),
                    () => editor.chain().focus().toggleBold().run(),
                    <Bold className="size-4" />,
                )}
                {tool(
                    'Italic',
                    editor.isActive('italic'),
                    () => editor.chain().focus().toggleItalic().run(),
                    <Italic className="size-4" />,
                )}
                {tool(
                    'Bulleted list',
                    editor.isActive('bulletList'),
                    () => editor.chain().focus().toggleBulletList().run(),
                    <List className="size-4" />,
                )}
                {tool(
                    'Numbered list',
                    editor.isActive('orderedList'),
                    () => editor.chain().focus().toggleOrderedList().run(),
                    <ListOrdered className="size-4" />,
                )}
                {tool(
                    editor.isActive('link') ? 'Remove link' : 'Add link',
                    editor.isActive('link'),
                    setLink,
                    <Link2 className="size-4" />,
                    editor.state.selection.empty && !editor.isActive('link'),
                )}
            </div>
            {linkOpen && (
                <form
                    className="flex items-center gap-2 border-b border-border px-2 py-1.5"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (/^https?:\/\//.test(linkHref)) editor.chain().focus().setLink({ href: linkHref }).run();
                        setLinkOpen(false);
                        setLinkHref('');
                    }}
                >
                    <input
                        autoFocus
                        type="url"
                        aria-label="Link address"
                        placeholder="https://"
                        value={linkHref}
                        onChange={(e) => setLinkHref(e.target.value)}
                        className={cn(
                            'h-7 flex-1 rounded-md border border-border bg-surface px-2 text-[13px]',
                            focusRing,
                        )}
                    />
                    <Button type="submit" size="xs" shape="square">
                        Link
                    </Button>
                    <Button type="button" size="xs" shape="square" variant="ghost" onClick={() => setLinkOpen(false)}>
                        Cancel
                    </Button>
                </form>
            )}
            <EditorContent editor={editor} />
            {editor.isEmpty && placeholder && (
                <p
                    aria-hidden
                    className="pointer-events-none -mt-24 mb-0 min-h-24 px-3 py-2 text-[13px] text-text-faint"
                >
                    {placeholder}
                </p>
            )}
        </div>
    );
}
