import type { RichText } from '@bylinecrm/shared';
import {
    Badge,
    Button,
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
import { CalendarClock, FileText, Mail, X } from 'lucide-react';
import { useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { Link } from 'react-router';
import { templates } from '../../../api/templates';
import { useSendMail } from '../../../api/mail';
import { useMailboxes } from '../../../api/mailAdmin';
import { useMailboxSignature } from '../../../api/signatures';
import { useTemplates } from '../../../api/templates';
import type { EmailTemplateView, MailboxView } from '../../../api/types';
import { useCan, useMembership, usePermission } from '../../../auth/capabilities';
import { RecordPicker } from '../../../components/RecordPicker';
import { ResponsivePanel } from '../../../components/ResponsivePanel';
import { RichTextEditor, type RichTextHandle } from '../../../components/rich-text/RichTextEditor';
import { failureText } from '../../../lib/errors';
import { paths } from '../../paths';
import { docToSubject, subjectToDoc } from '../templates/subject';
import {
    emptyVariables,
    emptyVariablesText,
    isBlank,
    ownSendingMailboxes,
    placesSignature,
    refusedVariables,
    sendInput,
    sendsAsTemplate,
    type TemplateFill,
} from './compose';
import { SchedulePicker } from './SchedulePicker';
import { senderTimeZone } from './schedule';

/** The person the mail is to and about: the record's person, or a deal's point of contact. */
export interface ComposerPerson {
    id: string;
    name: string;
    email: string | null;
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
    return <ComposerForm {...props} mailboxes={own} />;
}

const EMPTY_DOC: RichText = { type: 'doc', content: [{ type: 'paragraph' }] };

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
}: ComposerProps & { person: ComposerPerson; mailboxes: MailboxView[]; formHandle: Ref<ComposerHandle> }) {
    const id = useId();
    const [mailboxId, setMailboxId] = useState(mailboxes[0]?.id ?? '');
    const [alsoTo, setAlsoTo] = useState<{ id: string; name: string }[]>([]);
    const [subject, setSubject] = useState<RichText>(EMPTY_DOC);
    const [body, setBody] = useState<RichText>(EMPTY_DOC);
    const [fill, setFill] = useState<TemplateFill | null>(null);
    const [missing, setMissing] = useState<string[]>([]);
    // The editors take their content when they mount: a template fill or a reset remounts them.
    const [generation, setGeneration] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const subjectRef = useRef<RichTextHandle>(null);
    const bodyRef = useRef<RichTextHandle>(null);
    const send = useSendMail(workspaceId);
    // The signature (#193): the mailbox's as shown, until the sender edits or removes it for this message —
    // then this message's own, for that mailbox only; choosing another mailbox shows its signature.
    const mailboxSignature = useMailboxSignature(workspaceId, mailboxId);
    const [ownSignature, setOwnSignature] = useState<{ mailboxId: string; doc: RichText | null } | null>(null);
    const signatureTouched = ownSignature?.mailboxId === mailboxId;
    const signature = signatureTouched ? ownSignature.doc : (mailboxSignature.data?.effective ?? null);
    const signatureLocked = Object.values(mailboxSignature.data?.locked ?? {}).some(Boolean);

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

    const empty = emptyVariables(subject, body, missing);
    const blank = isBlank(body);
    const noSubject = !reply && docToSubject(subject).trim() === '';
    const blocked = empty.length > 0 || blank || noSubject || preview.isPending;
    const why = empty.length
        ? emptyVariablesText(empty, person.name)
        : blank
          ? 'Write a message to send.'
          : noSubject
            ? 'Add a subject to send.'
            : null;

    const submit = async (sendAt?: Date, timeZone?: string) => {
        setError(null);
        const input = sendInput({
            mailboxId,
            personId: person.id,
            dealId,
            alsoTo: alsoTo.map((p) => p.id),
            subject,
            body,
            fill,
            replyToMessageId: reply?.messageId,
            signature: signatureTouched ? signature : undefined,
            sendAt,
            timeZone: timeZone ?? senderTimeZone(),
        });
        const subjectText = docToSubject(subject) || (reply ? `Re: ${reply.subject.replace(/^re:\s*/i, '')}` : '');
        try {
            await send.mutateAsync({ send: input, subject: subjectText });
        } catch (e) {
            const refused = refusedVariables(e);
            if (refused.length) setMissing((m) => [...new Set([...m, ...refused])]);
            setError(failureText(e));
            throw e;
        }
        setSubject(EMPTY_DOC);
        setBody(EMPTY_DOC);
        setFill(null);
        setMissing([]);
        setAlsoTo([]);
        setOwnSignature(null);
        setGeneration((g) => g + 1);
        onSent?.();
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
                        <Badge key={p.id} shape="pill" className="gap-1 pr-0.5 text-text">
                            {p.name}
                            <button
                                type="button"
                                aria-label={`Remove ${p.name}`}
                                onClick={() => setAlsoTo((list) => list.filter((x) => x.id !== p.id))}
                                className={cn(
                                    'grid size-4.5 place-items-center rounded-full hover:bg-surface max-md:size-touch',
                                    focusRing,
                                )}
                            >
                                <X aria-hidden className="size-3" />
                            </button>
                        </Badge>
                    ))}
                    {!reply && (
                        <RecipientAdder
                            workspaceId={workspaceId}
                            exclude={[person.id, ...alsoTo.map((p) => p.id)]}
                            onAdd={(p) => setAlsoTo((list) => [...list, p])}
                        />
                    )}
                </div>
                <div className="ml-auto flex items-center gap-2">
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
                <div className="ml-auto flex items-center gap-2">
                    {onDiscard && (
                        <Button size="sm" shape="square" variant="ghost" onClick={onDiscard}>
                            Discard
                        </Button>
                    )}
                    <SchedulePicker
                        title="Schedule send"
                        confirm="Schedule send"
                        pending={send.isPending}
                        error={error ?? undefined}
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

/** Adds another person as a recipient, through the one record picker. */
function RecipientAdder({
    workspaceId,
    exclude,
    onAdd,
}: {
    workspaceId: string;
    exclude: readonly string[];
    onAdd: (person: { id: string; name: string }) => void;
}) {
    const names = useRef(new Map<string, string>());
    return (
        <RecordPicker
            workspaceId={workspaceId}
            object="person"
            label="Add recipient"
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
