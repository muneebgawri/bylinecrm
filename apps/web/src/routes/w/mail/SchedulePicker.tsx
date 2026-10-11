import { Button, Input } from '@bylinecrm/ui';
import { useId, useState, type ReactElement } from 'react';
import { ResponsivePanel } from '../../../components/ResponsivePanel';
import {
    RECIPIENT_ZONE_UNKNOWN,
    fromLocalInput,
    scheduleProblem,
    scheduleWindow,
    senderTimeZone,
    suggestedSendAt,
    toLocalInput,
} from './schedule';

/**
 * Picks when a send goes (P2-5): a time in the sender's zone, which the panel names, and the
 * recipient's, which it says is unknown. The minimum lead and the horizon are the API's numbers
 * (`scheduleProblem`), checked before the request so a time that cannot work says so at once.
 * A popover on a desktop, a sheet on a phone (`ResponsivePanel`).
 */
export function SchedulePicker({
    trigger,
    title,
    confirm,
    initial,
    pending,
    error,
    onConfirm,
}: {
    trigger: ReactElement;
    title: string;
    /** The confirm button's words ("Schedule send", "Reschedule"). */
    confirm: string;
    /** Where the picker starts; the next whole hour far enough ahead otherwise. */
    initial?: Date | undefined;
    pending: boolean;
    /** The server's refusal, in its words. */
    error?: string | undefined;
    onConfirm: (at: Date, timeZone: string) => Promise<unknown> | void;
}) {
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState('');
    const [problem, setProblem] = useState<string | null>(null);
    // The bounds are taken when the panel opens (the clock is read in the handler, not in render).
    const [bounds, setBounds] = useState<{ earliest: Date; latest: Date } | null>(null);
    const id = useId();
    const zone = senderTimeZone();

    const submit = async () => {
        const at = fromLocalInput(value);
        const why = scheduleProblem(at, Date.now());
        setProblem(why);
        if (why || !at) return;
        try {
            await onConfirm(at, zone);
            setOpen(false);
        } catch {
            // The server's words arrive as `error`; the panel stays open for another time.
        }
    };

    return (
        <ResponsivePanel
            title={title}
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (next) {
                    const now = Date.now();
                    setBounds(scheduleWindow(now));
                    setValue(toLocalInput(initial ?? suggestedSendAt(now)));
                    setProblem(null);
                }
            }}
            widthClass="w-[min(22rem,calc(100vw-2rem))]"
            trigger={trigger}
            footer={
                <>
                    <Button variant="ghost" size="sm" shape="square" onClick={() => setOpen(false)}>
                        Cancel
                    </Button>
                    <Button size="sm" shape="square" loading={pending} onClick={() => void submit()}>
                        {confirm}
                    </Button>
                </>
            }
        >
            <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <label htmlFor={`${id}-at`} className="text-[13px] font-medium">
                    Send at
                </label>
                <Input
                    id={`${id}-at`}
                    type="datetime-local"
                    value={value}
                    min={bounds ? toLocalInput(bounds.earliest) : undefined}
                    max={bounds ? toLocalInput(bounds.latest) : undefined}
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={`${id}-zones`}
                    onChange={(e) => {
                        setValue(e.target.value);
                        setProblem(null);
                    }}
                />
                <p id={`${id}-zones`} className="m-0 flex flex-col gap-0.5 text-xs text-text-muted">
                    <span>Your time zone: {zone}</span>
                    <span>{RECIPIENT_ZONE_UNKNOWN}</span>
                </p>
                {(problem ?? error) && (
                    <p role="alert" className="m-0 text-xs text-danger">
                        {problem ?? error}
                    </p>
                )}
            </form>
        </ResponsivePanel>
    );
}
