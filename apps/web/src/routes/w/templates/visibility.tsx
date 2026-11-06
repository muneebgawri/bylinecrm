import { TEMPLATE_VISIBILITIES, type TemplateVisibility } from '@bylinecrm/shared';
import { Badge, SegmentedControl } from '@bylinecrm/ui';
import { useMembership } from '../../../auth/capabilities';
import type { EmailTemplateView } from '../../../api/types';

export const VISIBILITY_LABEL: Record<TemplateVisibility, string> = { private: 'Only me', public: 'Public' };

const VISIBILITY_HINT: Record<TemplateVisibility, string> = {
    private: 'Only you see this template, and anyone whose role may see every template.',
    public: 'Every member of the workspace sees and can use this template.',
};

export function VisibilityBadge({ visibility }: { visibility: TemplateVisibility }) {
    return <Badge status={visibility === 'public' ? 'neutral' : 'accent'}>{VISIBILITY_LABEL[visibility]}</Badge>;
}

/** Whether the caller says who reads this template: its author, or `template:read_all` (the API's rule). */
export function useMaySetVisibility(template: Pick<EmailTemplateView, 'ownerMemberId'>): boolean {
    const membership = useMembership();
    if (!membership) return false;
    if (membership.capabilities.includes('template:read_all')) return true;
    return template.ownerMemberId !== null && template.ownerMemberId === membership.memberId;
}

export function VisibilityPicker({
    value,
    onChange,
    disabled,
}: {
    value: TemplateVisibility;
    onChange: (visibility: TemplateVisibility) => void;
    disabled?: boolean;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">Who can see it</span>
            <SegmentedControl
                aria-label="Who can see it"
                value={value}
                onValueChange={onChange}
                options={TEMPLATE_VISIBILITIES.map((v) => ({
                    value: v,
                    label: VISIBILITY_LABEL[v],
                    disabled: !!disabled,
                }))}
                className="self-start"
            />
            <p className="m-0 text-xs text-text-muted">
                {VISIBILITY_HINT[value]}
                {disabled ? ' Only its author, or someone who may see every template, can change this.' : ''}
            </p>
        </div>
    );
}
