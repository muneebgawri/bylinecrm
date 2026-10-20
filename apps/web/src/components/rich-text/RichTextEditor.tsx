import type { MailAssetView, RichText } from '@bylinecrm/shared';
import { Button, cn, focusRing } from '@bylinecrm/ui';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { TableKit } from '@tiptap/extension-table';
import { EditorContent, Node, useEditor, type AnyExtension, type Editor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListOrdered, Table2 } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { useUploadMailImage } from '../../api/mailAssets';
import { failureText } from '../../lib/errors';
import { ImageBar, TableBar, imageFilesOf, insertUploadedImage, mailImageProblem } from './media';
import { MissingVariables, VARIABLE_TRIGGER_EVENT, Variable, missingVariablesKey } from './variableNode';

/**
 * The product's one rich-text editor (Tiptap). Notes, task bodies, template bodies and template
 * subjects are the same editor with a different **profile** — what it may contain, which tools
 * the toolbar offers and which link schemes it accepts — so a fix to the editor is a fix
 * everywhere and nothing stores what its viewer or the API cannot handle.
 *
 * - `note`: headings, bold, italic, lists, http(s) links (what `RichTextView` shows).
 * - `template`: exactly the API's template subset (P2-4: paragraphs, h2/h3, bold, italic, lists,
 *   line breaks, `https:`/`mailto:` links) plus variable chips, images (uploaded — button, paste or drop —
 *   and served at a public https address, with alt text and a width) and tables. The composer's body too.
 * - `subject`: one line of text and variable chips; no marks, no blocks.
 * - `signature` (#193): the template subset's paragraphs, line breaks, bold, italic and links, variable
 *   chips, and images linked by https URL (uploaded, a Gmail import's, or the logo's chip) — no tables.
 */
export type RichTextProfile = 'note' | 'template' | 'subject' | 'signature';

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
    /**
     * Variables with no value for the recipient (template and subject profiles): their chips turn
     * red. The owner gets them from the API's preview; the editor only shows them.
     */
    missingVariables?: readonly string[] | undefined;
    /** Told when the editor gains focus, so a shared "Insert variable" knows where to insert. */
    onFocus?: () => void;
    handle?: Ref<RichTextHandle>;
    readOnly?: boolean;
    className?: string;
    /** Stores an image and gives its public address (image profiles); the current workspace's upload by default. */
    uploadImage?: (file: File) => Promise<MailAssetView>;
}

type Tool = 'h2' | 'h3' | 'bold' | 'italic' | 'bulletList' | 'orderedList' | 'link' | 'image' | 'table';

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
        tools: ['h2', 'h3', 'bold', 'italic', 'bulletList', 'orderedList', 'link', 'image', 'table'],
        linkSchemes: ['https', 'mailto'],
        singleLine: false,
        minHeightClass: 'min-h-48',
    },
    // One line, but still a finger's 44px on a phone whatever the font's metrics (FR-CRMS-UI-12).
    subject: { tools: [], singleLine: true, minHeightClass: 'max-md:min-h-touch' },
    signature: {
        tools: ['bold', 'italic', 'link', 'image'],
        linkSchemes: ['https', 'mailto'],
        singleLine: false,
        minHeightClass: 'min-h-16',
    },
};

/** A document with exactly one paragraph: the subject line. */
const SingleLineDocument = Node.create({ name: 'doc', topNode: true, content: 'paragraph' });

/** `trigger`: whether `{{` asks for a variable picker — only when the owner offers one. */
function extensionsFor(profile: RichTextProfile, trigger: boolean): AnyExtension[] {
    const spec = PROFILES[profile];
    const variables = [Variable.configure({ trigger }), MissingVariables];
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
    if (profile === 'template' || profile === 'signature') {
        // Images sit in a line (as mail carries them), by URL only — never a pasted data: URI.
        const images = [
            Image.configure({
                inline: true,
                allowBase64: false,
                HTMLAttributes: { class: 'inline max-w-full h-auto' },
            }),
        ];
        // Tables in a body only; the API refuses one in a signature. Fixed layout: no column resizing.
        const tables = profile === 'template' ? [TableKit.configure({ table: { resizable: false } })] : [];
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
            ...variables,
            ...images,
            ...tables,
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
        ...variables,
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
    missingVariables,
    onFocus,
    handle,
    readOnly = false,
    className,
    uploadImage: uploadOverride,
}: RichTextEditorProps) {
    const spec = PROFILES[profile];
    const workspaceUpload = useUploadMailImage();
    const upload = spec.tools.includes('image') ? (uploadOverride ?? workspaceUpload) : undefined;
    const [uploading, setUploading] = useState(0);
    const [mediaError, setMediaError] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    // The editor's paste and drop handlers are set once; they read the latest upload through this.
    const uploadFiles = useRef<(files: File[], at?: number) => void>(() => undefined);
    const editor = useEditor({
        extensions: extensionsFor(profile, onVariableTrigger !== undefined),
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
                    spec.singleLine ? 'py-1.5 whitespace-nowrap overflow-x-auto' : 'py-2',
                    spec.minHeightClass,
                ),
            },
            // A subject is one line: Enter does nothing rather than splitting it.
            handleKeyDown: (_view, event) => spec.singleLine && event.key === 'Enter',
            // A pasted or dropped image is uploaded and goes in by its public address, never as data.
            handlePaste: (_view, event) => {
                const files = imageFilesOf(event.clipboardData);
                if (files.length === 0 || !spec.tools.includes('image')) return false;
                uploadFiles.current(files);
                return true;
            },
            handleDrop: (view, event) => {
                const files = imageFilesOf(event.dataTransfer);
                if (files.length === 0 || !spec.tools.includes('image')) return false;
                const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
                uploadFiles.current(files, at);
                return true;
            },
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

    // The marks are plugin state, not content: handed over in a transaction that changes nothing else.
    const missingKey = (missingVariables ?? []).join('\n');
    useEffect(() => {
        if (!editor || editor.isDestroyed) return;
        const missing = new Set(missingKey ? missingKey.split('\n') : []);
        editor.view.dispatch(editor.state.tr.setMeta(missingVariablesKey, missing).setMeta('addToHistory', false));
    }, [editor, missingKey]);

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

    // The latest upload for the paste and drop handlers, kept current after each render.
    useEffect(() => {
        uploadFiles.current = (files: File[], at?: number) => {
            if (!editor) return;
            if (!upload) {
                setMediaError('Images can be added inside a workspace only.');
                return;
            }
            for (const file of files) {
                const problem = mailImageProblem(file);
                if (problem) {
                    setMediaError(problem);
                    continue;
                }
                setMediaError(null);
                setUploading((n) => n + 1);
                upload(file)
                    .then((asset) => insertUploadedImage(editor, asset, file.name, at))
                    .catch((error: unknown) => setMediaError(`The image was not added: ${failureText(error)}`))
                    .finally(() => setUploading((n) => n - 1));
            }
        };
    });

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
            {spec.tools.length > 0 && !readOnly && (
                <Toolbar
                    editor={editor}
                    tools={spec.tools}
                    onLink={setLink}
                    onImage={() => fileInput.current?.click()}
                    uploading={uploading > 0}
                />
            )}
            {spec.tools.includes('image') && !readOnly && (
                <input
                    ref={fileInput}
                    type="file"
                    accept="image/png,image/jpeg"
                    multiple
                    hidden
                    aria-label="Image to add"
                    onChange={(e) => {
                        uploadFiles.current([...(e.target.files ?? [])]);
                        e.target.value = '';
                    }}
                />
            )}
            {!readOnly && editor.isActive('image') && <ImageBar editor={editor} />}
            {!readOnly && spec.tools.includes('table') && editor.isActive('table') && <TableBar editor={editor} />}
            {(uploading > 0 || mediaError) && (
                <p
                    role={mediaError ? 'alert' : 'status'}
                    className={cn(
                        'm-0 border-b border-border px-3 py-1.5 text-xs',
                        mediaError ? 'text-danger' : 'text-text-muted',
                    )}
                >
                    {mediaError ?? 'Uploading the image…'}
                </p>
            )}
            {linkOpen && (
                <form
                    className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (!linkAllowed(profile, linkHref)) {
                            setLinkError(
                                profile === 'note'
                                    ? 'Use an http:// or https:// address.'
                                    : 'Use an https:// or mailto: address.',
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
                        placeholder={profile === 'note' ? 'https://' : 'https:// or mailto:'}
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
    image: {
        title: 'Add image',
        icon: <ImagePlus className="size-4" />,
        active: () => false,
        run: () => undefined,
    },
    table: {
        title: 'Insert table',
        icon: <Table2 className="size-4" />,
        active: (e) => e.isActive('table'),
        run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
};

function Toolbar({
    editor,
    tools,
    onLink,
    onImage,
    uploading,
}: {
    editor: Editor;
    tools: readonly Tool[];
    onLink: () => void;
    onImage: () => void;
    uploading: boolean;
}) {
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
                // A table never goes inside another (the API refuses it); an upload runs one at a time per click.
                const disabled =
                    (isLink && editor.state.selection.empty && !active) ||
                    (id === 'table' && active) ||
                    (id === 'image' && uploading);
                return (
                    <button
                        key={id}
                        type="button"
                        title={title}
                        aria-label={title}
                        aria-pressed={active}
                        disabled={disabled}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => (isLink ? onLink() : id === 'image' ? onImage() : tool.run(editor))}
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
