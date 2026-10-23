import { MAIL_FOLLOW_UPS_MAX, MAIL_SEND_RECIPIENTS_MAX, lintCompose, type RichText } from '@bylinecrm/shared';
import {
    Badge,
    Button,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Skeleton,
    cn,
    focusRing,
} from '@bylinecrm/ui';
import { useMutation } from '@tanstack/react-query';
import { CalendarClock, FileText, Mail, Plus, X } from 'lucide-react';
import { useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { Link } from 'react-router';
import { templates } from '../../../api/templates';
import { useRecordDrafts, useSendMail } from '../../../api/mail';
import { useMailboxes } from '../../../api/mailAdmin';
import { useMailboxSignature } from '../../../api/signatures';
import { useTemplates } from '../../../api/templates';
import type { EmailTemplateView, MailDraftView, MailboxView } from '../../../api/types';
import { useCan, useMembership, usePermission } from '../../../auth/capabilities';
import { RecordPicker } from '../../../components/RecordPicker';
import { ResponsivePanel } from '../../../components/ResponsivePanel';
import { RichTextEditor, type RichTextHandle } from '../../../components/rich-text/RichTextEditor';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';
import { paths } from '../../paths';
import { docToSubject, subjectToDoc } from '../templates/subject';
import {
    EMPTY_DOC,
    canAddFollowUp,
    draftContent,
    emptyVariables,
    hasDraftContent,
    parseAddresses,
    recipientLabel,
    stateFromDraft,
    withRecipient,
    type ComposerState,
    type CopyRecipient,
    emptyVariablesText,
    followUpProblem,
    isBlank,
    nextFollowUpAt,
    ownSendingMailboxes,
    placesSignature,
    refusedVariables,
    sendInput,
    sendsAsTemplate,
    type FollowUpDraft,
    type TemplateFill,
} from './compose';
import { useDraftSaver, type DraftSaveState } from './draftSave';
import { SchedulePicker } from './SchedulePicker';
import { fromLocalInput, senderTimeZone, toLocalInput } from './schedule';

/** The person the mail is to and about: the record's person, or a deal's point of contact. */
export interface ComposerPerson {
    id: string;
    name: string;
    email: string | null;
    /** Where the person came from (FR-CRMS-11); not `manual` = mail to them should carry an unsubscribe (REP-2). */
    source?: string | null | undefined;
}

/**
 * A reply: the stored message it answers, and the mailboxes holding it — a reply goes from one of them
 * (the API's rule; one email may be in several of the workspace's mailboxes, #107).
 */
export interface ComposerReply {
    messageId: string;
    mailboxIds: readonly string[];
    subject: string;
}

export interface ComposerHandle {
    /** Brings the composer into view and puts the caret in it (the `e` key, the "Email" action). */
    focus: () => void;
}

export interface ComposerProps {
    workspaceId: string;
    /** Null on a deal with no point of contact: `noPerson` says what to do instead. */
    person: ComposerPerson | null;
    noPerson?: string;
    dealId?: string | undefined;
    reply?: ComposerReply | undefined;
    autoFocus?: boolean;
    /** Told once the server has accepted the send (the sheet closes, the reply folds away). */
    onSent?: () => void;
    /** Offers a Discard button (a sheet, a reply); the inline composer has none. */
    onDiscard?: () => void;
    /**
     * The record composer's drafts: what is written is saved as the member's own draft for this person (on a
     * deal, for the person on that deal) as they write and when the composer closes, and put back when it opens
     * again; Send or Schedule deletes it, and "Discard draft" does. A reply has none.
     */
    drafts?: boolean;
    handle?: Ref<ComposerHandle>;
    className?: string;
}

/**
 * The compose box (doc 50 §A; FR-CRMS-2/3, FR-CRMS-UI-2): 1:1 mail from the member's own
 * connected personal mailbox, to the record's person and anyone added beside them. A template
 * fills the subject and body with variable chips, each resolved by the server's preview for this
 * person; an empty one is red and holds Send, naming itself — never a blank send. Send queues the
 * mail (the timeline shows it at once); Schedule sends it later, in the sender's zone.
 *
 * Before the form, the honest states: no permission, no person, no address, no mailbox to send
 * from — each says what to do, and nothing pretends it could send.
 */
export function Composer(props: ComposerProps) {
    const { person, reply } = props;
    const send = usePermission('email:send');
    const readMailboxes = useCan('mailbox:read');
    const root = useRef<HTMLDivElement>(null);
    const form = useRef<ComposerHandle>(null);
    useImperativeHandle(
        props.handle,
        () => ({
            focus: () => {
                root.current?.scrollIntoView({ block: 'nearest' });
                if (form.current) form.current.focus();
                else root.current?.focus();
            },
        }),
        [],
    );

    let content: ReactNode;
    if (!send.allowed || !readMailboxes) {
        content = (
            <Notice>
                {send.allowed ? 'Your role cannot see mailboxes, so it cannot send from one.' : send.reason}
            </Notice>
        );
    } else if (!person) {
        content = <Notice>{props.noPerson ?? 'Choose who this email is to first.'}</Notice>;
    } else if (!person.email) {
        content = <Notice>{`Add an email address to ${person.name} to write to them.`}</Notice>;
    } else {
        content = <MailboxGate {...props} person={person} formHandle={form} />;
    }
    return (
        <div
            ref={root}
            tabIndex={-1}
            aria-label={reply ? 'Reply' : `Email ${person?.name ?? ''}`.trim()}
            role="region"
            className={cn('outline-none', props.className)}
        >
            {content}
        </div>
    );
}

function Notice({ children }: { children: ReactNode }) {
    return (
        <p className="m-0 flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-[13px] text-text-muted">
            <Mail aria-hidden className="size-4 shrink-0" />
            {children}
        </p>
    );
}

/** Which mailboxes the member can send this from; the form once there is at least one. */
function MailboxGate(props: ComposerProps & { person: ComposerPerson; formHandle: Ref<ComposerHandle> }) {
    const { workspaceId, reply } = props;
    const membership = useMembership();
    const mailboxes = useMailboxes(workspaceId);

    if (mailboxes.isPending) {
        return <Skeleton className="h-40 rounded-lg" aria-label="Loading your mailboxes" />;
    }
    if (mailboxes.isError) {
        return (
            <div className="flex items-center gap-3 rounded-lg bg-surface-raised px-4 py-3 text-[13px] text-text-muted">
                <span>Your mailboxes could not be loaded.</span>
                <Button size="xs" shape="square" className="ml-auto" onClick={() => void mailboxes.refetch()}>
                    Retry
                </Button>
            </div>
        );
    }
    const own = ownSendingMailboxes(mailboxes.data, membership?.memberId).filter(
        (m) => !reply || reply.mailboxIds.includes(m.id),
    );
    if (own.length === 0) {
        if (reply) {
            return (
                <Notice>This message is in no mailbox of yours that can send, so a reply cannot go from here.</Notice>
            );
        }
        return (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed border-border px-4 py-3 text-[13px]">
                <Mail aria-hidden className="size-4 shrink-0 text-text-muted" />
                <span className="font-medium">Connect a mailbox to email from here</span>
                <Button asChild size="xs" shape="square" variant="secondary" className="ml-auto">
                    <Link to={paths.mailboxes(workspaceId)}>Mailboxes</Link>
                </Button>
            </div>
        );
    }
    return props.drafts && !reply ? (
        <DraftGate {...props} mailboxes={own} />
    ) : (
        <ComposerForm {...props} mailboxes={own} initialDraft={null} />
    );
}

type FormProps = ComposerProps & { person: ComposerPerson; mailboxes: MailboxView[]; formHandle: Ref<ComposerHandle> };

/**
 * The record composer's draft (the caller's own, for this person — on a deal, for the person on that deal), read
 * before the form so the form starts from it. A draft that cannot be read leaves the composer usable: it starts
 * empty, says so, and its first save finds the draft there (`409`) and offers it.
 */
function DraftGate(props: FormProps) {
    const drafts = useRecordDrafts(props.workspaceId, { type: 'person', id: props.person.id });
    // "Load that version" (another tab's) starts the form again from it.
    const [reloaded, setReloaded] = useState<{ view: MailDraftView; generation: number } | null>(null);
    // The form starts from the draft as the server has it now — another tab may have saved since this one last
    // read — and, once open, is never taken down by a later read (its own saves refresh the list).
    const [open, setOpen] = useState(false);
    const ready = open || (!drafts.isPending && !drafts.isFetching);
    if (ready && !open) setOpen(true);
    if (!ready) return <Skeleton className="h-40 rounded-lg" aria-label="Loading your draft" />;
    const found = drafts.data?.items.find((d) => d.dealId === (props.dealId ?? null)) ?? null;
    return (
        <ComposerForm
            key={reloaded?.generation ?? 0}
            {...props}
            initialDraft={reloaded?.view ?? found}
            draftLoadFailed={drafts.isError}
            onReloadDraft={(view) => setReloaded((r) => ({ view, generation: (r?.generation ?? 0) + 1 }))}
        />
    );
}

function ComposerForm({
    workspaceId,
    person,
    dealId,
    reply,
    autoFocus,
    onSent,
    onDiscard,
    mailboxes,
    formHandle,
    drafts,
    initialDraft,
    draftLoadFailed,
    onReloadDraft,
}: FormProps & {
    initialDraft: MailDraftView | null;
    draftLoadFailed?: boolean;
    onReloadDraft?: (view: MailDraftView) => void;
}) {
    const id = useId();
    const saveDrafts = !!drafts && !reply;
    // A saved draft puts back everything the composer held (taken once, when the form mounts).
    const [restored] = useState(() => (initialDraft ? stateFromDraft(person.id, initialDraft) : null));
    const [mailboxId, setMailboxId] = useState(
        mailboxes.find((m) => m.id === restored?.mailboxId)?.id ?? mailboxes[0]?.id ?? '',
    );
    const [alsoTo, setAlsoTo] = useState<{ id: string; name: string }[]>(() => [...(restored?.alsoTo ?? [])]);
    const [cc, setCc] = useState<CopyRecipient[]>(() => [...(restored?.cc ?? [])]);
    const [bcc, setBcc] = useState<CopyRecipient[]>(() => [...(restored?.bcc ?? [])]);
    // Cc and Bcc are behind a toggle, as in any mail client — open from the start when the draft has some.
    const [copies, setCopies] = useState(() => cc.length + bcc.length > 0);
    const [subject, setSubject] = useState<RichText>(restored?.subject ?? EMPTY_DOC);
    const [body, setBody] = useState<RichText>(restored?.body ?? EMPTY_DOC);
    const [fill, setFill] = useState<TemplateFill | null>(null);
    const [missing, setMissing] = useState<string[]>([]);
    // The editors take their content when they mount: a template fill or a reset remounts them.
    const [generation, setGeneration] = useState(0);
    const [error, setError] = useState<string | null>(null);
    // Follow-ups queued behind this email, each in its thread; `followUpKey` names their rows.
    const [followUps, setFollowUps] = useState<FollowUpDraft[]>(() => [...(restored?.followUps ?? [])]);
    const followUpKey = useRef(0);
    // The time picked to schedule it, kept with the draft until it is scheduled.
    const [scheduledFor, setScheduledFor] = useState<Date | null>(restored?.sendAt ?? null);
    const subjectRef = useRef<RichTextHandle>(null);
    const bodyRef = useRef<RichTextHandle>(null);
    const send = useSendMail(workspaceId);
    // The signature (#193): the mailbox's as shown, until the sender edits or removes it for this message —
    // then this message's own, for that mailbox only; choosing another mailbox shows its signature.
    const mailboxSignature = useMailboxSignature(workspaceId, mailboxId);
    const [ownSignature, setOwnSignature] = useState<{ mailboxId: string; doc: RichText | null } | null>(() =>
        restored && restored.signature !== undefined ? { mailboxId, doc: restored.signature } : null,
    );
    const signatureTouched = ownSignature?.mailboxId === mailboxId;
    const signature = signatureTouched ? ownSignature.doc : (mailboxSignature.data?.effective ?? null);
    const signatureLocked = Object.values(mailboxSignature.data?.locked ?? {}).some(Boolean);
    const saver = useDraftSaver({
        workspaceId,
        personId: person.id,
        dealId,
        initial: saveDrafts ? initialDraft : null,
    });

    useImperativeHandle(
        formHandle,
        () => ({ focus: () => (reply ? bodyRef.current?.focus() : subjectRef.current?.focus()) }),
        [reply],
    );

    const preview = useMutation({
        mutationFn: (template: EmailTemplateView) =>
            templates.preview(workspaceId, template.id, { personId: person.id, dealId }),
    });

    const applyTemplate = async (template: EmailTemplateView) => {
        setError(null);
        const filled: TemplateFill = {
            templateId: template.id,
            name: template.name,
            subject: subjectToDoc(template.subject),
            body: template.body,
        };
        try {
            const rendered = await preview.mutateAsync(template);
            setMissing(rendered.missing);
        } catch (e) {
            setError(`The template could not be checked for ${person.name}: ${failureText(e)}`);
            return;
        }
        // A reply keeps its own subject (the thread's, `Re:` on the server); only the body is filled.
        if (!reply) setSubject(filled.subject);
        setBody(filled.body);
        setFill(filled);
        setGeneration((g) => g + 1);
    };

    // A draft filled from a template: the template as it is now, so the composer can tell whether the draft still
    // is it (it sends as the template) or was edited (it sends as written), and which of its variables are empty.
    const restoredTemplate = useRef(restored?.templateId ?? null);
    const previewTemplate = preview.mutateAsync;
    useEffect(() => {
        const templateId = restoredTemplate.current;
        restoredTemplate.current = null;
        if (!templateId) return;
        void (async () => {
            try {
                const template = await templates.get(workspaceId, templateId);
                const rendered = await previewTemplate(template);
                setMissing(rendered.missing);
                setFill({
                    templateId: template.id,
                    name: template.name,
                    subject: subjectToDoc(template.subject),
                    body: template.body,
                });
            } catch {
                // The template is gone or cannot be read: the draft sends as written, which it says.
            }
        })();
    }, [workspaceId, previewTemplate]);

    const state: ComposerState = {
        mailboxId,
        alsoTo,
        cc,
        bcc,
        subject,
        body,
        templateId: fill?.templateId ?? null,
        signature: signatureTouched ? signature : undefined,
        sendAt: scheduledFor,
        followUps,
    };
    const content = draftContent(person.id, state, senderTimeZone());
    const contentJson = JSON.stringify(content);
    // Every change is saved as the draft a moment later — not what the form opened with, and not an empty composer
    // that has no draft yet.
    const opened = useRef(contentJson);
    useEffect(() => {
        if (!saveDrafts || contentJson === opened.current) return;
        opened.current = '';
        if (saver.draftId() === null && saver.state.kind === 'none' && !hasDraftContent(state)) return;
        saver.change(content);
        // `state` and `content` are this change's; `contentJson` says when they changed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contentJson, saveDrafts]);

    const recipients = 1 + alsoTo.length + cc.length + bcc.length;
    const roomFor = MAIL_SEND_RECIPIENTS_MAX - recipients;

    const empty = emptyVariables(subject, body, missing);
    // REP-2: what spam filters punish, as warnings — never a block. A reply is a conversation, not bulk.
    const lint = lintCompose({
        subject: docToSubject(subject),
        body,
        bulk: !reply && !!person.source && person.source !== 'manual',
    });
    const blank = isBlank(body);
    const noSubject = !reply && docToSubject(subject).trim() === '';
    const followUpBlank = followUps.some((f) => isBlank(f.body));
    const blocked = empty.length > 0 || blank || noSubject || followUpBlank || preview.isPending;
    const why = empty.length
        ? emptyVariablesText(empty, person.name)
        : blank
          ? 'Write a message to send.'
          : noSubject
            ? 'Add a subject to send.'
            : followUpBlank
              ? 'Write each follow-up’s message.'
              : null;
    // A follow-up with no subject of its own takes the thread's, as the server will.
    const threadSubject = `Re: ${(docToSubject(subject) || reply?.subject || '…').replace(/^re:\s*/i, '')}`;

    const addFollowUp = () => {
        followUpKey.current += 1;
        const key = `follow-up-${followUpKey.current}`;
        const now = Date.now();
        setFollowUps((list) => [
            ...list,
            { key, sendAt: nextFollowUpAt(list, now), subject: EMPTY_DOC, body: EMPTY_DOC },
        ]);
    };
    const changeFollowUp = (key: string, change: Partial<FollowUpDraft>) =>
        setFollowUps((list) => list.map((f) => (f.key === key ? { ...f, ...change } : f)));

    /** Back to an empty composer: after a send, or a draft discarded. */
    const reset = () => {
        setSubject(EMPTY_DOC);
        setBody(EMPTY_DOC);
        setFill(null);
        setMissing([]);
        setAlsoTo([]);
        setCc([]);
        setBcc([]);
        setCopies(false);
        setOwnSignature(null);
        setFollowUps([]);
        setScheduledFor(null);
        setGeneration((g) => g + 1);
    };

    const submit = async (sendAt?: Date, timeZone?: string) => {
        setError(null);
        const problem = followUpProblem(followUps, (sendAt ?? new Date()).getTime(), Date.now());
        if (problem) {
            setError(problem);
            throw new Error(problem);
        }
        // The draft goes with the send: no save may land after it to bring it back.
        const draftId = saveDrafts ? await saver.settle() : null;
        const input = sendInput({
            mailboxId,
            personId: person.id,
            dealId,
            alsoTo: alsoTo.map((p) => p.id),
            cc,
            bcc,
            draftId: draftId ?? undefined,
            subject,
            body,
            fill,
            replyToMessageId: reply?.messageId,
            signature: signatureTouched ? signature : undefined,
            sendAt,
            timeZone: timeZone ?? senderTimeZone(),
            followUps,
        });
        const subjectText = docToSubject(subject) || (reply ? `Re: ${reply.subject.replace(/^re:\s*/i, '')}` : '');
        try {
            await send.mutateAsync({ send: input, subject: subjectText });
        } catch (e) {
            const refused = refusedVariables(e);
            if (refused.length) setMissing((m) => [...new Set([...m, ...refused])]);
            setError(failureText(e));
            // Not sent: the draft keeps what is written.
            if (saveDrafts) saver.change(content);
            throw e;
        }
        if (saveDrafts) saver.sent();
        reset();
        onSent?.();
    };

    const discardDraft = async () => {
        setError(null);
        try {
            await saver.discard();
        } catch (e) {
            setError(`The draft could not be discarded: ${failureText(e)}`);
            return;
        }
        reset();
        onDiscard?.();
    };

    return (
        <div className="rounded-lg border border-border bg-surface-raised shadow-sm">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3.5 py-2.5 text-[13px] text-text-muted">
                <div className="flex min-w-0 items-center gap-2">
                    <span id={`${id}-from`}>From</span>
                    <Select value={mailboxId} onValueChange={setMailboxId}>
                        <SelectTrigger
                            aria-labelledby={`${id}-from`}
                            className="h-7 w-auto min-w-0 max-w-64 text-[13px]"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {mailboxes.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                    {m.label ? `${m.label} · ${m.email}` : m.email}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="To">
                    <span aria-hidden>To</span>
                    <Badge shape="pill" className="text-text" title={person.email ?? undefined}>
                        {person.name}
                    </Badge>
                    {alsoTo.map((p) => (
                        <RecipientChip
                            key={p.id}
                            label={p.name}
                            onRemove={() => setAlsoTo((list) => list.filter((x) => x.id !== p.id))}
                        />
                    ))}
                    {!reply && roomFor > 0 && (
                        <RecipientAdder
                            workspaceId={workspaceId}
                            label="Add recipient"
                            exclude={[person.id, ...alsoTo.map((p) => p.id)]}
                            onAdd={(p) => setAlsoTo((list) => [...list, p])}
                        />
                    )}
                    {!copies && (
                        <Button
                            size="xs"
                            shape="square"
                            variant="ghost"
                            aria-expanded={false}
                            onClick={() => setCopies(true)}
                        >
                            Cc/Bcc
                        </Button>
                    )}
                </div>
                <div className="ml-auto flex items-center gap-2">
                    {saveDrafts && <DraftChip state={saver.state} />}
                    {fill && (
                        <span className="text-xs">
                            Template <b className="font-medium text-text">{fill.name}</b>
                            {!sendsAsTemplate({ fill, subject, body, replyToMessageId: reply?.messageId }) && (
                                <Badge status="warning" className="ml-1.5">
                                    edited — sends as written
                                </Badge>
                            )}
                        </span>
                    )}
                    <TemplateMenu
                        workspaceId={workspaceId}
                        pending={preview.isPending}
                        onPick={(t) => void applyTemplate(t)}
                    />
                </div>
            </div>
            {copies && (
                <div className="flex flex-col gap-1.5 border-b border-border px-3.5 py-2 text-[13px] text-text-muted">
                    <CopyField workspaceId={workspaceId} field="Cc" list={cc} room={roomFor} onChange={setCc} />
                    <CopyField workspaceId={workspaceId} field="Bcc" list={bcc} room={roomFor} onChange={setBcc} />
                </div>
            )}
            {saver.state.kind === 'conflict' && (
                <div
                    role="alert"
                    className="flex flex-wrap items-center gap-2 border-b border-border bg-warning-soft px-3.5 py-2 text-[13px]"
                >
                    <span>
                        This draft was saved in another tab {formatWhen(saver.state.theirs.updatedAt)}. Saving here is
                        paused.
                    </span>
                    <span className="ml-auto flex gap-2">
                        <Button
                            size="xs"
                            shape="square"
                            variant="secondary"
                            onClick={() => {
                                if (saver.state.kind !== 'conflict') return;
                                saver.abandon();
                                onReloadDraft?.(saver.state.theirs);
                            }}
                        >
                            Load that version
                        </Button>
                        <Button size="xs" shape="square" onClick={() => void saver.keepMine()}>
                            Keep mine
                        </Button>
                    </span>
                </div>
            )}
            {draftLoadFailed && saver.state.kind === 'none' && (
                <p className="m-0 border-b border-border px-3.5 py-1.5 text-xs text-text-muted">
                    Your saved draft could not be loaded; what you write now is saved as you go.
                </p>
            )}
            <div className="border-b border-border bg-surface">
                <RichTextEditor
                    key={`subject-${generation}`}
                    profile="subject"
                    value={subject}
                    onChange={setSubject}
                    handle={subjectRef}
                    aria-label="Subject"
                    placeholder={reply ? `Re: ${reply.subject.replace(/^re:\s*/i, '')}` : 'Subject'}
                    missingVariables={missing}
                    className="rounded-none border-0"
                />
            </div>
            <div className="bg-surface">
                <RichTextEditor
                    key={`body-${generation}`}
                    profile="template"
                    value={body}
                    onChange={setBody}
                    handle={bodyRef}
                    autoFocus={autoFocus ?? false}
                    aria-label="Message"
                    placeholder={`Write to ${person.name}…`}
                    missingVariables={missing}
                    className="rounded-none border-0 [&_.rich-text]:min-h-28"
                />
            </div>
            {signature ? (
                <div className="border-t border-dashed border-border bg-surface">
                    <RichTextEditor
                        key={`signature-${mailboxId}-${generation}`}
                        profile="signature"
                        value={signature}
                        onChange={(doc) => setOwnSignature({ mailboxId, doc })}
                        aria-label="Signature"
                        className="rounded-none border-0 [&_.rich-text]:min-h-0 [&_[role=toolbar]]:hidden focus-within:[&_[role=toolbar]]:flex"
                    />
                    {(placesSignature(body) || !signatureLocked) && (
                        <div className="flex items-center justify-end gap-2 px-2 pb-1.5">
                            {placesSignature(body) && (
                                <p className="m-0 mr-auto text-xs text-text-muted">
                                    Goes where the message says {'{{sender.signature}}'}.
                                </p>
                            )}
                            {!signatureLocked && (
                                <Button
                                    size="xs"
                                    shape="square"
                                    variant="ghost"
                                    onClick={() => setOwnSignature({ mailboxId, doc: null })}
                                >
                                    Remove signature
                                </Button>
                            )}
                        </div>
                    )}
                </div>
            ) : (
                signatureTouched &&
                mailboxSignature.data?.effective && (
                    <div className="flex border-t border-dashed border-border bg-surface px-2 py-1.5">
                        <Button size="xs" shape="square" variant="ghost" onClick={() => setOwnSignature(null)}>
                            Add signature
                        </Button>
                    </div>
                )
            )}
            {followUps.length > 0 && (
                <ol aria-label="Follow-ups" className="m-0 list-none border-t border-border p-0">
                    {followUps.map((f, index) => (
                        <FollowUpRow
                            key={`${f.key}-${generation}`}
                            followUp={f}
                            number={index + 1}
                            threadSubject={threadSubject}
                            missing={missing}
                            onChange={(change) => changeFollowUp(f.key, change)}
                            onRemove={() => setFollowUps((list) => list.filter((x) => x.key !== f.key))}
                        />
                    ))}
                </ol>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-border px-3.5 py-2.5">
                {why && (
                    <p
                        id={`${id}-why`}
                        role={empty.length ? 'alert' : undefined}
                        className={cn(
                            'm-0 text-xs',
                            empty.length
                                ? 'rounded-full bg-danger-soft px-2.5 py-0.5 font-medium text-danger'
                                : 'text-text-faint',
                        )}
                    >
                        {why}
                    </p>
                )}
                {error && (
                    <p role="alert" className="m-0 w-full text-xs text-danger">
                        {error}
                    </p>
                )}
                {lint.length > 0 && (
                    <ul aria-label="Deliverability warnings" className="m-0 w-full list-none p-0 text-xs text-warning">
                        {lint.map((l) => (
                            <li key={l.code}>{l.message}</li>
                        ))}
                    </ul>
                )}
                <Button
                    size="sm"
                    shape="square"
                    variant="ghost"
                    disabled={!canAddFollowUp(followUps)}
                    title={
                        canAddFollowUp(followUps)
                            ? 'Queue an email that goes in this thread later, unless they answer'
                            : `At most ${MAIL_FOLLOW_UPS_MAX} follow-ups`
                    }
                    onClick={addFollowUp}
                >
                    <Plus aria-hidden />
                    Add follow-up
                </Button>
                <div className="ml-auto flex items-center gap-2">
                    {saveDrafts
                        ? (saver.state.kind !== 'none' || hasDraftContent(state) || onDiscard) && (
                              <Button size="sm" shape="square" variant="ghost" onClick={() => void discardDraft()}>
                                  Discard draft
                              </Button>
                          )
                        : onDiscard && (
                              <Button size="sm" shape="square" variant="ghost" onClick={onDiscard}>
                                  Discard
                              </Button>
                          )}
                    <SchedulePicker
                        title="Schedule send"
                        confirm="Schedule send"
                        initial={scheduledFor ?? undefined}
                        pending={send.isPending}
                        error={error ?? undefined}
                        onValueChange={setScheduledFor}
                        onConfirm={(at, zone) => submit(at, zone)}
                        trigger={
                            <Button
                                size="sm"
                                shape="square"
                                variant="secondary"
                                disabled={blocked}
                                aria-describedby={why ? `${id}-why` : undefined}
                            >
                                <CalendarClock aria-hidden />
                                Schedule
                            </Button>
                        }
                    />
                    <Button
                        size="sm"
                        shape="square"
                        disabled={blocked}
                        loading={send.isPending}
                        aria-describedby={why ? `${id}-why` : undefined}
                        onClick={() => void submit().catch(() => undefined)}
                    >
                        Send
                    </Button>
                </div>
            </div>
        </div>
    );
}

/**
 * One queued follow-up: when it goes, in the sender's zone (the picker's rule; the API checks again), its subject —
 * empty is the thread's `Re: …` — and its message, in the composer's own editors. It goes in the thread as a reply
 * to the email before it, and not at all if the person answers first.
 */
function FollowUpRow({
    followUp,
    number,
    threadSubject,
    missing,
    onChange,
    onRemove,
}: {
    followUp: FollowUpDraft;
    number: number;
    threadSubject: string;
    missing: readonly string[];
    onChange: (change: Partial<FollowUpDraft>) => void;
    onRemove: () => void;
}) {
    const id = useId();
    const zone = senderTimeZone();
    return (
        <li className="border-b border-dashed border-border last:border-b-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-surface-raised px-3.5 py-2 text-[13px] text-text-muted">
                <span className="font-medium text-text">Follow-up {number}</span>
                <label htmlFor={`${id}-at`}>Sends</label>
                <Input
                    id={`${id}-at`}
                    type="datetime-local"
                    aria-label={`Follow-up ${number} send time`}
                    aria-describedby={`${id}-zone`}
                    value={followUp.sendAt ? toLocalInput(followUp.sendAt) : ''}
                    onChange={(e) => onChange({ sendAt: fromLocalInput(e.target.value) })}
                    className="h-7 w-auto text-[13px]"
                />
                <span id={`${id}-zone`} className="text-xs">
                    {zone} · unless they answer first
                </span>
                <Button
                    size="xs"
                    shape="square"
                    variant="ghost"
                    className="ml-auto"
                    aria-label={`Remove follow-up ${number}`}
                    onClick={onRemove}
                >
                    <X aria-hidden />
                </Button>
            </div>
            <div className="border-y border-border bg-surface">
                <RichTextEditor
                    profile="subject"
                    value={followUp.subject}
                    onChange={(doc) => onChange({ subject: doc })}
                    aria-label={`Follow-up ${number} subject`}
                    placeholder={threadSubject}
                    missingVariables={missing}
                    className="rounded-none border-0"
                />
            </div>
            <div className="bg-surface">
                <RichTextEditor
                    profile="template"
                    value={followUp.body}
                    onChange={(doc) => onChange({ body: doc })}
                    aria-label={`Follow-up ${number} message`}
                    placeholder="Write the follow-up…"
                    missingVariables={missing}
                    className="rounded-none border-0 [&_.rich-text]:min-h-20"
                />
            </div>
        </li>
    );
}

/** A recipient's chip, with its remove button. */
function RecipientChip({ label, title, onRemove }: { label: string; title?: string; onRemove: () => void }) {
    return (
        <Badge shape="pill" className="gap-1 pr-0.5 text-text" title={title}>
            {label}
            <button
                type="button"
                aria-label={`Remove ${label}`}
                onClick={onRemove}
                className={cn(
                    'grid size-4.5 place-items-center rounded-full hover:bg-surface max-md:size-touch',
                    focusRing,
                )}
            >
                <X aria-hidden className="size-3" />
            </button>
        </Badge>
    );
}

/**
 * Cc or Bcc: anyone — a person picked from the CRM, or any address typed (or pasted, several at once) and taken
 * on Enter, a comma or leaving the field. An address that is not one says so and stays to be fixed. The API's
 * recipient guard judges each one as it does To; nobody is added to the CRM by being copied.
 */
function CopyField({
    workspaceId,
    field,
    list,
    room,
    onChange,
}: {
    workspaceId: string;
    field: 'Cc' | 'Bcc';
    list: readonly CopyRecipient[];
    /** How many more recipients the message takes (to, cc and bcc together). */
    room: number;
    onChange: (list: CopyRecipient[]) => void;
}) {
    const id = useId();
    const [text, setText] = useState('');
    const [problem, setProblem] = useState<string | null>(null);

    const take = (value: string = text) => {
        const { addresses, invalid } = parseAddresses(value);
        const fits = addresses.slice(0, Math.max(room, 0));
        if (fits.length) onChange(fits.reduce((acc, address) => withRecipient(acc, { address }), [...list]));
        setText(invalid.join(' '));
        setProblem(
            invalid.length
                ? `${invalid.map((i) => `“${i}”`).join(', ')} ${invalid.length === 1 ? 'is not an email address' : 'are not email addresses'}`
                : fits.length < addresses.length
                  ? `At most ${MAIL_SEND_RECIPIENTS_MAX} recipients on one email`
                  : null,
        );
    };

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label={field}>
                <span aria-hidden className="w-7">
                    {field}
                </span>
                {list.map((r) => (
                    <RecipientChip
                        key={'personId' in r ? r.personId : r.address}
                        label={recipientLabel(r)}
                        onRemove={() => onChange(list.filter((x) => x !== r))}
                    />
                ))}
                {room > 0 && (
                    <>
                        <input
                            type="text"
                            inputMode="email"
                            autoComplete="off"
                            aria-label={`${field} address`}
                            aria-invalid={problem ? true : undefined}
                            aria-describedby={problem ? `${id}-problem` : undefined}
                            placeholder="Type an address"
                            value={text}
                            onChange={(e) => {
                                setText(e.target.value);
                                setProblem(null);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
                                    e.preventDefault();
                                    take();
                                } else if (e.key === 'Backspace' && text === '' && list.length > 0) {
                                    onChange(list.slice(0, -1));
                                }
                            }}
                            onPaste={(e) => {
                                const pasted = e.clipboardData.getData('text');
                                if (!/[\s,;]/.test(pasted.trim())) return;
                                e.preventDefault();
                                take(`${text} ${pasted}`);
                            }}
                            onBlur={() => {
                                if (text.trim()) take();
                            }}
                            className={cn(
                                'h-7 min-w-40 flex-1 rounded-md bg-transparent px-1.5 text-[13px] text-text outline-none placeholder:text-text-faint',
                                focusRing,
                            )}
                        />
                        <RecipientAdder
                            workspaceId={workspaceId}
                            label={`Add ${field} person`}
                            exclude={list.flatMap((r) => ('personId' in r ? [r.personId] : []))}
                            onAdd={(p) => onChange(withRecipient(list, { personId: p.id, name: p.name }))}
                        />
                    </>
                )}
            </div>
            {problem && (
                <p id={`${id}-problem`} className="m-0 pl-8.5 text-xs text-danger">
                    {problem}
                </p>
            )}
        </div>
    );
}

/** Where the composer's draft stands, beside the template: saving, saved (and when), or not saved. */
function DraftChip({ state }: { state: DraftSaveState }) {
    if (state.kind === 'none' || state.kind === 'conflict') return null;
    return (
        <span role="status" className="flex items-center gap-1.5 text-xs">
            <Badge status={state.kind === 'failed' ? 'warning' : 'neutral'}>Draft</Badge>
            {state.kind === 'saving'
                ? 'Saving…'
                : state.kind === 'saved'
                  ? `Saved ${formatWhen(state.at)}`
                  : 'Not saved — tried again as you write'}
        </span>
    );
}

/** Adds a person as a recipient, through the one record picker. */
function RecipientAdder({
    workspaceId,
    label,
    exclude,
    onAdd,
}: {
    workspaceId: string;
    label: string;
    exclude: readonly string[];
    onAdd: (person: { id: string; name: string }) => void;
}) {
    const names = useRef(new Map<string, string>());
    return (
        <RecordPicker
            workspaceId={workspaceId}
            object="person"
            label={label}
            placeholder="Add person"
            value={null}
            onResolved={(personId, title) => names.current.set(personId, title)}
            onChange={(personId) => {
                if (personId && !exclude.includes(personId)) {
                    onAdd({ id: personId, name: names.current.get(personId) ?? 'Person' });
                }
            }}
            className="w-auto"
        />
    );
}

/**
 * The member's personal templates — outreach templates belong to sequences and are never offered
 * for 1:1 mail (the API refuses them too). Loaded when the menu opens.
 */
function TemplateMenu({
    workspaceId,
    pending,
    onPick,
}: {
    workspaceId: string;
    pending: boolean;
    onPick: (template: EmailTemplateView) => void;
}) {
    const [open, setOpen] = useState(false);
    const canRead = useCan('template:read');
    if (!canRead) return null;
    return (
        <ResponsivePanel
            title="Insert a template"
            open={open}
            onOpenChange={setOpen}
            widthClass="w-[min(22rem,calc(100vw-2rem))]"
            trigger={
                <Button size="xs" shape="square" variant="ghost" loading={pending} aria-haspopup="dialog">
                    <FileText aria-hidden />
                    Template
                </Button>
            }
        >
            <TemplateList
                workspaceId={workspaceId}
                onPick={(t) => {
                    setOpen(false);
                    onPick(t);
                }}
            />
        </ResponsivePanel>
    );
}

function TemplateList({ workspaceId, onPick }: { workspaceId: string; onPick: (template: EmailTemplateView) => void }) {
    const list = useTemplates(workspaceId, { kind: 'personal' });
    const items = list.data?.pages.flatMap((p) => p.items) ?? [];
    if (list.isPending) return <Skeleton className="h-24" aria-label="Loading templates" />;
    if (list.isError) return <p className="m-0 text-[13px] text-danger">{failureText(list.error)}</p>;
    if (items.length === 0) {
        return (
            <p className="m-0 text-[13px] text-text-muted">
                No personal templates yet.{' '}
                <Link to={paths.templates(workspaceId)} className="text-accent underline">
                    Write one
                </Link>
                .
            </p>
        );
    }
    return (
        <ul
            className="m-0 flex max-h-72 list-none flex-col gap-0.5 overflow-y-auto p-0"
            aria-label="Personal templates"
        >
            {items.map((t) => (
                <li key={t.id}>
                    <button
                        type="button"
                        onClick={() => onPick(t)}
                        className={cn(
                            'flex w-full flex-col rounded-md px-2.5 py-1.5 text-left hover:bg-surface-raised max-md:min-h-touch',
                            focusRing,
                        )}
                    >
                        <span className="text-[13px] font-medium">{t.name}</span>
                        <span className="truncate text-xs text-text-muted">{t.subject}</span>
                    </button>
                </li>
            ))}
        </ul>
    );
}
