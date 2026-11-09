import {
    CALL_DISPOSITIONS,
    CALL_DISPOSITION_LABELS,
    e164Of,
    type CallDisposition,
    type Phone,
    type RichText,
} from '@bylinecrm/shared';
import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    toast,
} from '@bylinecrm/ui';
import { PhoneOutgoing } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLogCall } from '../../../api/calls';
import { RichTextEditor } from '../../../components/rich-text/RichTextEditor';
import { failureText } from '../../../lib/errors';

const EMPTY: RichText = { type: 'doc', content: [{ type: 'paragraph' }] };

/**
 * The Call panel (CALL-1, Salesloft's dialer and notepad): "Call" on a person opens their number in the Quo app
 * (a `tel:` link, which the Quo desktop app handles once it is the computer's calling app) and this panel beside
 * it — a running clock, the outcome, and the notes. Save logs the call on the person's timeline with the note;
 * Quo's own report of the call, with its recording, merges into the same entry when it arrives.
 */
export function CallPanel({
    workspaceId,
    personId,
    personName,
    phone,
    open,
    onOpenChange,
}: {
    workspaceId: string;
    personId: string;
    personName: string;
    phone: Phone | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const number = e164Of(phone) ?? (phone ? phone.number : null);
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-md:h-dvh max-md:max-h-dvh max-md:rounded-none">
                <DialogTitle className="pr-12">Call {personName}</DialogTitle>
                <DialogDescription>
                    {number ? `${number} · opens in Quo` : 'This person has no phone number the CRM can dial.'}
                </DialogDescription>
                {/* Mounted with the panel: a fresh clock, outcome and notes each time it opens. */}
                {open && (
                    <CallSession
                        workspaceId={workspaceId}
                        personId={personId}
                        number={number}
                        onDone={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function CallSession({
    workspaceId,
    personId,
    number,
    onDone,
}: {
    workspaceId: string;
    personId: string;
    number: string | null;
    onDone: () => void;
}) {
    const log = useLogCall(workspaceId);
    const [startedAt] = useState(() => new Date());
    const [elapsed, setElapsed] = useState(0);
    const [disposition, setDisposition] = useState<CallDisposition | null>(null);
    const [note, setNote] = useState<RichText>(EMPTY);
    const [dialled, setDialled] = useState(false);

    // The clock runs from the moment the panel opened: the call is being placed in Quo.
    useEffect(() => {
        const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.getTime()) / 1000)), 1000);
        return () => clearInterval(timer);
    }, [startedAt]);

    const dial = () => {
        if (!number) return;
        setDialled(true);
        window.location.href = `tel:${number}`;
    };
    const save = () => {
        if (!disposition) return;
        log.mutate(
            {
                personId,
                direction: 'outbound',
                disposition,
                startedAt: startedAt.toISOString(),
                durationSec: elapsed,
                ...(hasText(note) ? { note } : {}),
            },
            {
                onSuccess: () => {
                    toast({ title: 'Call logged', tone: 'success' });
                    onDone();
                },
                onError: (e) =>
                    toast({ title: 'The call was not logged', description: failureText(e), tone: 'danger' }),
            },
        );
    };
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const seconds = String(elapsed % 60).padStart(2, '0');

    return (
        <>
            <DialogBody className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                    <Button type="button" variant="primary" disabled={!number} onClick={dial}>
                        <PhoneOutgoing aria-hidden />
                        {dialled ? 'Open in Quo again' : 'Call in Quo'}
                    </Button>
                    <span role="timer" className="font-mono text-[13px] text-text-muted" aria-label="Call timer">
                        {minutes}:{seconds}
                    </span>
                </div>
                <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
                    <legend className="mb-1 text-[13px] font-medium text-text">Outcome</legend>
                    <div className="flex flex-wrap gap-1.5">
                        {CALL_DISPOSITIONS.map((d) => (
                            <label
                                key={d}
                                className={`cursor-pointer rounded-full border px-2.5 py-1 text-[13px] ${
                                    disposition === d
                                        ? 'border-accent bg-accent-soft text-text'
                                        : 'border-border text-text-muted hover:text-text'
                                }`}
                            >
                                <input
                                    type="radio"
                                    name="disposition"
                                    value={d}
                                    checked={disposition === d}
                                    onChange={() => setDisposition(d)}
                                    className="sr-only"
                                />
                                {CALL_DISPOSITION_LABELS[d]}
                            </label>
                        ))}
                    </div>
                </fieldset>
                <div className="rounded-md border border-border bg-surface">
                    <RichTextEditor
                        profile="note"
                        value={note}
                        onChange={setNote}
                        aria-label="Call notes"
                        placeholder="What was said, what comes next…"
                        className="rounded-none border-0 [&_.rich-text]:min-h-32"
                    />
                </div>
            </DialogBody>
            <DialogFooter>
                <Button type="button" variant="ghost" onClick={onDone}>
                    Discard
                </Button>
                <Button type="button" variant="primary" disabled={!disposition} loading={log.isPending} onClick={save}>
                    Save call
                </Button>
            </DialogFooter>
        </>
    );
}

function hasText(doc: RichText): boolean {
    return JSON.stringify(doc).includes('"text":"');
}
