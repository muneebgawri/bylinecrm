import {
    MAIL_IMAGE_MAX_BYTES,
    MAIL_IMAGE_MIME_TYPES,
    TEMPLATE_IMAGE_ALT_MAX,
    TEMPLATE_IMAGE_MAX_WIDTH,
    type MailAssetView,
} from '@bylinecrm/shared';
import { Button, cn, focusRing } from '@bylinecrm/ui';
import type { Editor } from '@tiptap/react';
import { useState, type FormEvent } from 'react';

/**
 * The rich-text editor's images and tables: what the composer, templates and (images only) signatures
 * add beyond text. An image is uploaded and goes in by its public https address with alt text and a
 * width; a table is edited a row or column at a time from the bar shown while the caret is in one.
 */

/** Why a file cannot be a mail image, or `null` when it can; the API checks again on upload. */
export function mailImageProblem(file: File): string | null {
    if (!(MAIL_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) return 'Choose a PNG or JPEG image.';
    if (file.size > MAIL_IMAGE_MAX_BYTES) {
        return `An image is at most ${Math.round(MAIL_IMAGE_MAX_BYTES / (1024 * 1024))} MB.`;
    }
    return null;
}

/** The image files a paste or a drop carries. */
export function imageFilesOf(data: DataTransfer | null | undefined): File[] {
    return [...(data?.files ?? [])].filter((f) => f.type.startsWith('image/'));
}

/** The width an uploaded image goes in at: as stored, never wider than an email's column. */
export function initialWidth(asset: Pick<MailAssetView, 'width'>): number {
    return Math.min(asset.width, TEMPLATE_IMAGE_MAX_WIDTH);
}

/** Puts an uploaded image in at the caret (or where it was dropped), its alt text the file's name to start. */
export function insertUploadedImage(editor: Editor, asset: MailAssetView, fileName: string, at?: number): void {
    if (editor.isDestroyed) return;
    const alt = fileName.replace(/\.[a-z0-9]+$/i, '').slice(0, TEMPLATE_IMAGE_ALT_MAX);
    const node = { type: 'image', attrs: { src: asset.url, alt, width: initialWidth(asset) } };
    const chain = editor.chain().focus();
    (at === undefined ? chain.insertContent(node) : chain.insertContentAt(at, node)).run();
}

const barClass = 'flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5';
const inputClass = cn(
    'h-7 rounded-md border border-border bg-surface px-2 text-[13px] max-md:h-touch max-md:text-touch',
    focusRing,
);

/** The selected image's alt text and width (1 to the column's width), applied together. */
export function ImageBar({ editor }: { editor: Editor }) {
    const attrs = editor.getAttributes('image') as { src?: string; alt?: string | null; width?: number | null };
    // Keyed by the image, so selecting another starts from its own values.
    return <ImageForm key={attrs.src ?? ''} editor={editor} alt={attrs.alt ?? ''} width={attrs.width ?? null} />;
}

function ImageForm({
    editor,
    alt: initialAlt,
    width: initialWidthValue,
}: {
    editor: Editor;
    alt: string;
    width: number | null;
}) {
    const [alt, setAlt] = useState(initialAlt);
    const [width, setWidth] = useState(initialWidthValue ? String(initialWidthValue) : '');
    const [error, setError] = useState<string | null>(null);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        const n = width.trim() === '' ? null : Number(width);
        if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= TEMPLATE_IMAGE_MAX_WIDTH)) {
            setError(`A width is 1 to ${TEMPLATE_IMAGE_MAX_WIDTH} pixels.`);
            return;
        }
        setError(null);
        editor
            .chain()
            .focus()
            .updateAttributes('image', { alt: alt.slice(0, TEMPLATE_IMAGE_ALT_MAX), width: n })
            .run();
    };
    return (
        <form aria-label="Image" className={barClass} onSubmit={submit} noValidate>
            <input
                aria-label="Alt text"
                placeholder="Alt text: what the image shows"
                value={alt}
                maxLength={TEMPLATE_IMAGE_ALT_MAX}
                onChange={(e) => setAlt(e.target.value)}
                className={cn(inputClass, 'min-w-0 flex-1')}
            />
            <input
                aria-label="Width in pixels"
                inputMode="numeric"
                placeholder="Width"
                value={width}
                onChange={(e) => setWidth(e.target.value.replace(/[^0-9]/g, ''))}
                className={cn(inputClass, 'w-20')}
            />
            <Button type="submit" size="xs" shape="square">
                Apply
            </Button>
            <Button
                type="button"
                size="xs"
                shape="square"
                variant="ghost"
                onClick={() => editor.chain().focus().deleteSelection().run()}
            >
                Remove image
            </Button>
            {error && (
                <p role="alert" className="m-0 w-full text-xs text-danger">
                    {error}
                </p>
            )}
        </form>
    );
}

const TABLE_ACTIONS: { label: string; run: (e: Editor) => boolean; can: (e: Editor) => boolean }[] = [
    { label: 'Add row', run: (e) => e.chain().focus().addRowAfter().run(), can: (e) => e.can().addRowAfter() },
    { label: 'Delete row', run: (e) => e.chain().focus().deleteRow().run(), can: (e) => e.can().deleteRow() },
    {
        label: 'Add column',
        run: (e) => e.chain().focus().addColumnAfter().run(),
        can: (e) => e.can().addColumnAfter(),
    },
    {
        label: 'Delete column',
        run: (e) => e.chain().focus().deleteColumn().run(),
        can: (e) => e.can().deleteColumn(),
    },
    { label: 'Delete table', run: (e) => e.chain().focus().deleteTable().run(), can: (e) => e.can().deleteTable() },
];

/** Rows and columns of the table the caret is in, a step at a time. */
export function TableBar({ editor }: { editor: Editor }) {
    return (
        <div role="toolbar" aria-label="Table" className={barClass}>
            {TABLE_ACTIONS.map((action) => (
                <Button
                    key={action.label}
                    type="button"
                    size="xs"
                    shape="square"
                    variant="ghost"
                    disabled={!action.can(editor)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => action.run(editor)}
                >
                    {action.label}
                </Button>
            ))}
        </div>
    );
}
