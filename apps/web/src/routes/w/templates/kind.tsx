import { TEMPLATE_KINDS, type TemplateKind } from '@bylinecrm/shared';
import { Badge, Button, SegmentedControl, cn, focusRing } from '@bylinecrm/ui';
import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { ResponsivePanel } from '../../../components/ResponsivePanel';

/**
 * A template's kind, said one way everywhere it appears. `personal` is 1:1 mail; `outreach` is
 * mail a sequence sends, and carries the locked unsubscribe-and-address footer (FR-CRMS-7/12).
 * Choosing `outreach` needs `outreach:write`; the API refuses it otherwise and so does every picker.
 */
export const KIND_LABEL: Record<TemplateKind, string> = { personal: 'Personal', outreach: 'Outreach' };
const KIND_HINT: Record<TemplateKind, string> = {
    personal: 'One person at a time, from your own mailbox.',
    outreach: 'Sent by sequences; ends with the unsubscribe link and the workspace’s postal address.',
};
export const OUTREACH_REASON = 'Your role cannot write outreach templates.';

export function KindBadge({ kind }: { kind: TemplateKind }) {
    return <Badge status={kind === 'outreach' ? 'accent' : 'neutral'}>{KIND_LABEL[kind]}</Badge>;
}

/** The two kinds side by side: in a form, where there is room for both. */
export function KindPicker({
    value,
    onChange,
    outreachAllowed,
}: {
    value: TemplateKind;
    onChange: (kind: TemplateKind) => void;
    outreachAllowed: boolean;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <SegmentedControl
                aria-label="Kind"
                value={value}
                onValueChange={onChange}
                options={TEMPLATE_KINDS.map((kind) => ({
                    value: kind,
                    label: KIND_LABEL[kind],
                    disabled: kind === 'outreach' && !outreachAllowed,
                }))}
                className="self-start"
            />
            <p className="m-0 text-xs text-text-muted">
                {value === 'personal' && !outreachAllowed ? `${KIND_HINT[value]} ${OUTREACH_REASON}` : KIND_HINT[value]}
            </p>
        </div>
    );
}

/** The kind as a compact control in the editor's header: a popover on a desktop, a sheet on a phone. */
export function KindMenu({
    value,
    onChange,
    outreachAllowed,
    disabled,
}: {
    value: TemplateKind;
    onChange: (kind: TemplateKind) => void;
    outreachAllowed: boolean;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    return (
        <ResponsivePanel
            title="Kind"
            open={open}
            onOpenChange={setOpen}
            widthClass="w-[min(22rem,calc(100vw-2rem))]"
            trigger={
                <Button
                    variant="secondary"
                    shape="square"
                    size="sm"
                    disabled={disabled}
                    aria-label={`Kind: ${KIND_LABEL[value]}`}
                >
                    {KIND_LABEL[value]}
                    <ChevronDown aria-hidden />
                </Button>
            }
        >
            <div role="radiogroup" aria-label="Kind" className="flex flex-col gap-1">
                {TEMPLATE_KINDS.map((kind) => {
                    const blocked = kind === 'outreach' && !outreachAllowed;
                    return (
                        <button
                            key={kind}
                            type="button"
                            role="radio"
                            aria-checked={kind === value}
                            disabled={blocked}
                            title={blocked ? OUTREACH_REASON : undefined}
                            onClick={() => {
                                onChange(kind);
                                setOpen(false);
                            }}
                            className={cn(
                                'flex min-h-touch items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-surface-raised disabled:opacity-50 md:min-h-0',
                                focusRing,
                            )}
                        >
                            <Check
                                aria-hidden
                                className={cn('mt-0.5 size-4 shrink-0', kind === value ? 'opacity-100' : 'opacity-0')}
                            />
                            <span>
                                <span className="block text-[13px] font-medium">{KIND_LABEL[kind]}</span>
                                <span className="block text-xs text-text-muted">
                                    {blocked ? OUTREACH_REASON : KIND_HINT[kind]}
                                </span>
                            </span>
                        </button>
                    );
                })}
            </div>
        </ResponsivePanel>
    );
}
