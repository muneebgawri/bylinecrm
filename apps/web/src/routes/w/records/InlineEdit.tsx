import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn, focusRing } from '@bylinecrm/ui';
import { ExternalLink, Pencil } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ApiError } from '../../../api/client';

/**
 * The inline-edit contract (FR-CRMS-UI-2): a value reads as text; a click (or Enter on it)
 * turns it into a control; Enter saves, Esc reverts, leaving the control saves when changed.
 * The new value shows at once; a refused save puts the old one back and says why under the
 * field, using the API's field error when it names this field. A reader without the capability
 * sees plain text with the reason in its tooltip — never a control that then refuses.
 */
export interface InlineProps {
    label: string;
    /** The `custom.<key>` or field path the API names in a field error for this value. */
    path: string;
    canEdit: boolean;
    /** Why editing is not offered; the tooltip (FR-CRMS-UI-6). */
    reason?: string | undefined;
    onSave: (value: string | null) => Promise<unknown>;
    className?: string;
}

export interface InlineTextProps extends InlineProps {
    value: string | null;
    type?: 'text' | 'email' | 'url' | 'number' | 'date' | 'tel';
    /** How the value reads at rest when it is set; defaults to the value itself. Text only — a link goes in `href`. */
    display?: ((value: string) => ReactNode) | undefined;
    /**
     * Where the value opens, when it is a link (a profile URL). The link is its own control beside
     * the edit button, never inside it: a link inside a button is two controls in one and a screen
     * reader or a tap can reach only one of them.
     */
    href?: ((value: string) => string) | undefined;
    placeholder?: string | undefined;
}

/** The message for this field from a failed save, or the error's own message. */
export function messageFor(error: unknown, path: string): string {
    if (error instanceof ApiError) {
        const field = error.fieldErrors.find((f) => f.path === path || f.path.endsWith(`.${path}`));
        return field?.message ?? error.message;
    }
    return error instanceof Error ? error.message : 'Could not save.';
}

export function InlineText({
    label,
    path,
    value,
    type = 'text',
    display,
    href,
    placeholder,
    canEdit,
    reason,
    onSave,
    className,
}: InlineTextProps) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value ?? '');
    const [shown, setShown] = useState(value);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const errorId = useId();
    const nameId = useId();
    const valueId = useId();

    // A value that changed underneath (a refetch after a save, another member's edit) wins over
    // what we remembered — only when the prop itself changed, never because editing ended. This
    // is React's "adjust state when a prop changes" shape: compared and set during render.
    const [seen, setSeen] = useState(value);
    if (seen !== value) {
        setSeen(value);
        setShown(value);
        if (!editing) setDraft(value ?? '');
    }

    useEffect(() => {
        if (editing) inputRef.current?.select();
    }, [editing]);

    const begin = () => {
        if (!canEdit) return;
        setDraft(shown ?? '');
        setError(null);
        setEditing(true);
    };

    const cancel = () => {
        setEditing(false);
        setDraft(shown ?? '');
    };

    const commit = async () => {
        const next = draft.trim() === '' ? null : draft.trim();
        setEditing(false);
        if (next === (shown ?? null)) return;
        const previous = shown;
        setShown(next);
        setSaving(true);
        try {
            await onSave(next);
            setError(null);
        } catch (e) {
            setShown(previous);
            setDraft(previous ?? '');
            setError(messageFor(e, path));
        } finally {
            setSaving(false);
        }
    };

    const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    };

    return (
        <div className={cn('group flex flex-col gap-0.5', className)}>
            {editing ? (
                <Input
                    ref={inputRef}
                    aria-label={label}
                    type={type}
                    value={draft}
                    placeholder={placeholder}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKey}
                    onBlur={() => void commit()}
                    className="h-7 px-2 text-[13px] max-md:h-touch max-md:text-touch"
                />
            ) : (
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={begin}
                        disabled={!canEdit}
                        title={canEdit ? `Edit ${label.toLowerCase()}` : reason}
                        aria-labelledby={`${nameId} ${valueId}`}
                        aria-describedby={error ? errorId : undefined}
                        className={cn(
                            'flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-sm px-1 text-left text-[13px] disabled:cursor-default max-md:min-h-touch',
                            canEdit && 'hover:bg-surface-raised',
                            saving && 'opacity-70',
                            focusRing,
                        )}
                    >
                        {/* The name is the field's label then the value as it reads (WCAG 2.5.3, label in
                            name); `aria-labelledby` joins the two with a space. */}
                        <span id={nameId} className="sr-only">
                            {label}:
                        </span>
                        <span id={valueId} className={cn('min-w-0 truncate', shown === null && 'text-text-faint')}>
                            {shown === null ? (
                                <>
                                    <span aria-hidden>—</span>
                                    <span className="sr-only">not set</span>
                                </>
                            ) : display ? (
                                display(shown)
                            ) : (
                                shown
                            )}
                        </span>
                        {canEdit && (
                            <Pencil
                                aria-hidden
                                className="ml-auto size-3 shrink-0 text-text-faint opacity-0 group-hover:opacity-100"
                            />
                        )}
                    </button>
                    {href && shown !== null && (
                        <a
                            href={href(shown)}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open ${label}`}
                            className={cn(
                                'grid size-7 shrink-0 place-items-center rounded-sm text-text-faint hover:text-accent max-md:size-touch',
                                focusRing,
                            )}
                        >
                            <ExternalLink aria-hidden className="size-3.5" />
                        </a>
                    )}
                </div>
            )}
            {error && (
                <p id={errorId} role="alert" className="m-0 px-1 text-xs text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}

export interface InlineSelectProps extends InlineProps {
    value: string | null;
    options: readonly { value: string; label: string }[];
    /** The option a cleared value reads as; omit to make the field required. */
    clearLabel?: string | undefined;
    /** The trigger's id, so a page shortcut can focus it. */
    id?: string | undefined;
}

const CLEAR = '__none__';

export function InlineSelect({
    label,
    path,
    value,
    options,
    clearLabel,
    canEdit,
    reason,
    onSave,
    className,
    id,
}: InlineSelectProps) {
    const [shown, setShown] = useState(value);
    const [error, setError] = useState<string | null>(null);
    const [seen, setSeen] = useState(value);
    if (seen !== value) {
        setSeen(value);
        setShown(value);
    }

    const change = async (next: string) => {
        const resolved = next === CLEAR ? null : next;
        if (resolved === shown) return;
        const previous = shown;
        setShown(resolved);
        try {
            await onSave(resolved);
            setError(null);
        } catch (e) {
            setShown(previous);
            setError(messageFor(e, path));
        }
    };

    const current = options.find((o) => o.value === shown);
    if (!canEdit) {
        return (
            <span className={cn('block px-1 text-[13px]', !current && 'text-text-faint', className)} title={reason}>
                {current?.label ?? clearLabel ?? '—'}
            </span>
        );
    }
    return (
        <div className={cn('flex flex-col gap-0.5', className)}>
            <Select value={shown ?? CLEAR} onValueChange={(v) => void change(v)}>
                <SelectTrigger id={id} aria-label={label} className="h-7 px-2 text-[13px]">
                    <SelectValue placeholder={clearLabel ?? '—'} />
                </SelectTrigger>
                <SelectContent>
                    {clearLabel && <SelectItem value={CLEAR}>{clearLabel}</SelectItem>}
                    {options.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                            {o.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {error && (
                <p role="alert" className="m-0 px-1 text-xs text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}
