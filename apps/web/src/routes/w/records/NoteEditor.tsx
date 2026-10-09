import type { RichText } from '@bylinecrm/shared';
import { RichTextEditor } from '../../../components/rich-text/RichTextEditor';

/**
 * The rich-text editor for notes and task bodies — its own chunk, loaded when a person starts
 * writing (FR-CRMS-UI-10; it must not enter the initial bundle). It is the product's one editor
 * (`RichTextEditor`) in its `note` profile: headings, bold, italic, lists and links, so what is
 * stored is what `RichTextView` can show.
 */
export interface NoteEditorProps {
    value: RichText;
    onChange: (value: RichText) => void;
    /** Focus the editor when it mounts (a new note). */
    autoFocus?: boolean;
    placeholder?: string;
    'aria-label': string;
}

export default function NoteEditor(props: NoteEditorProps) {
    return <RichTextEditor profile="note" {...props} />;
}
