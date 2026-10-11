import { Button, Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@bylinecrm/ui';
import { Braces } from 'lucide-react';
import { useRef, useState } from 'react';
import { ResponsivePanel } from '../../../components/ResponsivePanel';
import type { TemplateVariablesView, TemplateVariableView } from '../../../api/types';

/**
 * The one way a variable enters a template (doc 50 §C): pick it from the registry the API lists
 * (`GET /templates/variables`), grouped Person / Company / Deal / Sender / Custom fields. The button
 * opens it; so does typing `{{` in the subject or the body. A popover on a desktop, a sheet on a phone.
 */
const GROUPS: readonly { source: TemplateVariableView['source']; heading: string }[] = [
    { source: 'person', heading: 'Person' },
    { source: 'company', heading: 'Company' },
    { source: 'deal', heading: 'Deal' },
    { source: 'sender', heading: 'Sender' },
];

const SOURCE_LABEL: Record<TemplateVariableView['source'], string> = {
    person: 'Person',
    company: 'Company',
    deal: 'Deal',
    sender: 'Sender',
};

export interface VariablePickerProps {
    variables: TemplateVariablesView | undefined;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /**
     * The chosen variable. Called once the picker has closed and would otherwise hand focus back to
     * its button, so the owner's insert — which focuses the editor — is the last word on focus (#108).
     */
    onPick: (path: string) => void;
    /**
     * Asked where focus goes when the picker closes without a pick (Escape, a click outside). The
     * owner moves it and answers `true` — back to the editor when `{{` opened the picker, so the writer
     * is where they were typing — or answers `false` and it returns to the "Insert variable" button,
     * which is right when that button opened it.
     */
    restoreFocus?: () => boolean;
    disabled?: boolean;
}

/** Every typed word appears in the variable's group, label or path, in any order and any case. */
export function matchesVariable(query: string, variable: TemplateVariableView, label: string): boolean {
    const haystack = `${SOURCE_LABEL[variable.source]} ${label} ${variable.path}`.toLowerCase();
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((word) => haystack.includes(word));
}

export function VariablePicker({ variables, open, onOpenChange, onPick, restoreFocus, disabled }: VariablePickerProps) {
    const [q, setQ] = useState('');
    const shown = (variable: TemplateVariableView, label: string) => matchesVariable(q, variable, label);
    const customLabel = (v: TemplateVariableView) => `${SOURCE_LABEL[v.source]} · ${v.label}`;
    const anyShown =
        variables !== undefined &&
        (variables.standard.some((v) => shown(v, v.label)) || variables.custom.some((v) => shown(v, customLabel(v))));
    // The pick waits for the close: inserting first would focus the editor, then lose it to the
    // panel handing focus back to its button.
    const picked = useRef<string | null>(null);
    const pick = (path: string) => {
        picked.current = path;
        onOpenChange(false);
        setQ('');
    };
    const onCloseAutoFocus = (event: Event) => {
        const path = picked.current;
        picked.current = null;
        if (path !== null) {
            event.preventDefault();
            onPick(path);
        } else if (restoreFocus?.()) {
            event.preventDefault();
        }
    };
    const item = (variable: TemplateVariableView, label: string) => (
        <CommandItem key={variable.path} value={variable.path} onSelect={() => pick(variable.path)}>
            <span className="min-w-0 flex-1">
                <span className="block truncate">{label}</span>
                <span className="block truncate font-mono text-xs text-text-muted">{variable.path}</span>
            </span>
            {variable.optional && <span className="text-xs text-text-faint">optional</span>}
        </CommandItem>
    );
    return (
        <ResponsivePanel
            title="Insert variable"
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) setQ('');
            }}
            widthClass="w-[min(24rem,calc(100vw-2rem))]"
            onCloseAutoFocus={onCloseAutoFocus}
            trigger={
                <Button variant="secondary" shape="square" size="sm" disabled={disabled}>
                    <Braces aria-hidden />
                    Insert variable
                </Button>
            }
        >
            {/* The picker filters itself: any word, any order (cmdk's own matcher reads words in order). */}
            <Command className="bg-surface" label="Variables" shouldFilter={false}>
                <CommandInput value={q} onValueChange={setQ} placeholder="Search variables…" />
                <CommandList className="max-h-80">
                    {!anyShown && (
                        <p className="m-0 px-2 py-4 text-center text-sm text-text-muted">
                            {variables ? 'No variable matches.' : 'Loading variables…'}
                        </p>
                    )}
                    {variables &&
                        GROUPS.map((group) => {
                            const list = variables.standard.filter(
                                (v) => v.source === group.source && shown(v, v.label),
                            );
                            return list.length ? (
                                <CommandGroup key={group.source} heading={group.heading}>
                                    {list.map((v) => item(v, v.label))}
                                </CommandGroup>
                            ) : null;
                        })}
                    {variables && variables.custom.some((v) => shown(v, customLabel(v))) && (
                        <CommandGroup heading="Custom fields">
                            {variables.custom
                                .filter((v) => shown(v, customLabel(v)))
                                .map((v) => item(v, customLabel(v)))}
                        </CommandGroup>
                    )}
                </CommandList>
            </Command>
        </ResponsivePanel>
    );
}
