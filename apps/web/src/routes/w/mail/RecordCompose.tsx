import { Dialog, DialogContent, DialogDescription, DialogTitle, useIsMobile } from '@bylinecrm/ui';
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Composer, type ComposerHandle, type ComposerPerson } from './Composer';

export interface RecordComposeHandle {
    /** The record's "Email" action and `e`: the inline composer on a desktop, the sheet on a phone. */
    start: () => void;
}

/**
 * The compose box where a record page puts it (doc 50 §A): at the top of the activity column on a
 * tablet or desktop; on a phone (FR-CRMS-UI-12) a full-screen sheet raised by the bottom bar's
 * "Email", so the record stays readable and the keyboard has the whole screen.
 */
export function RecordCompose({
    workspaceId,
    person,
    noPerson,
    dealId,
    handle,
}: {
    workspaceId: string;
    person: ComposerPerson | null;
    noPerson?: string;
    dealId?: string | undefined;
    handle?: Ref<RecordComposeHandle>;
}) {
    const phone = useIsMobile();
    const [open, setOpen] = useState(false);
    const inline = useRef<ComposerHandle>(null);
    useImperativeHandle(handle, () => ({ start: () => (phone ? setOpen(true) : inline.current?.focus()) }), [phone]);

    const common = { workspaceId, person, dealId, ...(noPerson ? { noPerson } : {}) };
    if (!phone) return <Composer {...common} handle={inline} />;
    const name = person?.name ?? 'this person';
    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-md:h-dvh max-md:max-h-dvh max-md:rounded-none max-md:pt-4">
                <DialogTitle className="pr-12">Email {name}</DialogTitle>
                <DialogDescription className="sr-only">Write an email to {name}.</DialogDescription>
                <Composer {...common} autoFocus onSent={() => setOpen(false)} onDiscard={() => setOpen(false)} />
            </DialogContent>
        </Dialog>
    );
}
