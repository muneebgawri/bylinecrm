import { Button, Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@bylinecrm/ui';
import { Braces } from 'lucide-react';
import { useState } from 'react';
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
    onPick: (path: string) => void;
    disabled?: boolean;
}

export function VariablePicker({ variables, open, onOpenChange, onPick, disabled }: VariablePickerProps) {
    const [q, setQ] = useState('');
    const pick = (path: string) => {
        onOpenChange(false);
        setQ('');
        onPick(path);
    };
    const item = (variable: TemplateVariableView, label: string) => (
        <CommandItem key={variable.path} value={`${label} ${variable.path}`} onSelect={() => pick(variable.path)}>
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
            trigger={
                <Button variant="secondary" shape="square" size="sm" disabled={disabled}>
                    <Braces aria-hidden />
                    Insert variable
                </Button>
            }
        >
            <Command className="bg-surface" label="Variables">
                <CommandInput value={q} onValueChange={setQ} placeholder="Search variables…" />
                <CommandList className="max-h-80">
                    <CommandEmpty>{variables ? 'No variable matches.' : 'Loading variables…'}</CommandEmpty>
                    {variables &&
                        GROUPS.map((group) => {
                            const list = variables.standard.filter((v) => v.source === group.source);
                            return list.length ? (
                                <CommandGroup key={group.source} heading={group.heading}>
                                    {list.map((v) => item(v, v.label))}
                                </CommandGroup>
                            ) : null;
                        })}
                    {variables && variables.custom.length > 0 && (
                        <CommandGroup heading="Custom fields">
                            {variables.custom.map((v) => item(v, `${SOURCE_LABEL[v.source]} · ${v.label}`))}
                        </CommandGroup>
                    )}
                </CommandList>
            </Command>
        </ResponsivePanel>
    );
}
