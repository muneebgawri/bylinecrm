import { LOST_REASON_LABELS, LOST_REASONS, type LostReason } from '@bylinecrm/shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bylinecrm/ui';

/** The lost-reason picklist (#242): required on every move into a lost stage. */
export function LostReasonSelect({
    value,
    onChange,
    id,
}: {
    value: LostReason | '';
    onChange: (reason: LostReason) => void;
    id?: string;
}) {
    return (
        <Select value={value} onValueChange={(v) => onChange(v as LostReason)}>
            <SelectTrigger id={id} aria-label="Lost reason" className="w-full">
                <SelectValue placeholder="Pick a reason" />
            </SelectTrigger>
            <SelectContent>
                {LOST_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                        {LOST_REASON_LABELS[r]}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
