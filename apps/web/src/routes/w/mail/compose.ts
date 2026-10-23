import {
    MAIL_FOLLOW_UPS_MAX,
    SIGNATURE_PLACEMENT_VARIABLE,
    normaliseEmail,
    type RichText,
    type RichTextNode,
} from '@bylinecrm/shared';
import { ApiError } from '../../../api/client';
import type { MailDraftContent, MailDraftView, MailboxView, SendMailInput } from '../../../api/types';
import { templateVariablePaths } from '../templates/preview';
import { docToSubject, subjectToDoc } from '../templates/subject';
import { scheduleProblem } from './schedule';

/** An empty editor's document. */
export const EMPTY_DOC: RichText = { type: 'doc', content: [{ type: 'paragraph' }] };

/**
 * The record composer's rules (doc 50 §A, FR-CRMS-2/3), apart from its screen so each is stated
 * once and tested on its own.
 */

/**
 * The mailboxes a member may send 1:1 mail from: their own, personal, connected ones. A pool
 * mailbox is for sequences (Phase 3) and never offered here; another member's never is either —
 * the API refuses both (403), so offering them would only make a send fail.
 */
export function ownSendingMailboxes(
    mailboxes: readonly MailboxView[],
    memberId: string | null | undefined,
): MailboxView[] {
    return mailboxes.filter(
        (m) => m.purpose === 'personal' && m.status === 'connected' && !!memberId && m.ownerMemberId === memberId,
    );
}

/** Whether a rich-text document has nothing in it a reader would see. */
export function isBlank(doc: RichText): boolean {
    const visible = (nodes: readonly RichTextNode[] | undefined): boolean =>
        (nodes ?? []).some(
            (n) =>
                (n.type === 'text' && (n.text ?? '').trim() !== '') ||
                n.type === 'variable' ||
                n.type === 'image' ||
                visible(n.content),
        );
    return !visible(doc.content);
}

/** Whether the body places the signature itself (`{{sender.signature}}`, #193) rather than taking it at the end. */
export function placesSignature(body: RichText): boolean {
    const names = (nodes: readonly RichTextNode[] | undefined): boolean =>
        (nodes ?? []).some(
            (n) =>
                (n.type === 'variable' &&
                    (n['attrs'] as { path?: unknown } | undefined)?.path === SIGNATURE_PLACEMENT_VARIABLE) ||
                names(n.content),
        );
    return names(body.content);
}

/** The variables the draft uses that have no value for this person — what disables Send. */
export function emptyVariables(subject: RichText, body: RichText, missing: readonly string[]): string[] {
    if (missing.length === 0) return [];
    const unset = new Set(missing);
    return templateVariablePaths(docToSubject(subject), body).filter((path) => unset.has(path));
}

/** "custom.lastOutlet is empty" / "a and b are empty": the words under the composer. */
export function emptyVariablesText(paths: readonly string[], recipient: string): string {
    const list =
        paths.length === 1 ? paths[0] : `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1] ?? ''}`;
    return `${list} ${paths.length === 1 ? 'is' : 'are'} empty for ${recipient} · Send is disabled`;
}

/** A template as it was filled in, to tell whether the draft still IS that template. */
export interface TemplateFill {
    templateId: string;
    name: string;
    subject: RichText;
    body: RichText;
}

/**
 * A copy recipient (cc, bcc): a person in the CRM — sent to at their primary address, named as the picker showed
 * them — or any address typed in, someone not in the CRM included. An address is never made a person by this.
 */
export type CopyRecipient = { personId: string; name: string } | { address: string };

/** Whether two recipients are the same one: the same person, or the same address. */
const sameRecipient = (a: CopyRecipient, b: CopyRecipient) =>
    'personId' in a ? 'personId' in b && a.personId === b.personId : 'address' in b && a.address === b.address;

/** The words a recipient's chip shows: a person's name, or the address. */
export const recipientLabel = (r: CopyRecipient) => ('personId' in r ? r.name : r.address);

/** `list` with `r` added at the end, unless it is in it already. */
export function withRecipient(list: readonly CopyRecipient[], r: CopyRecipient): CopyRecipient[] {
    return list.some((x) => sameRecipient(x, r)) ? [...list] : [...list, r];
}

/**
 * What was typed into a cc or bcc field, as addresses (`normaliseEmail`, the one rule for an address the API's
 * suppression and exclusions read by): commas, semicolons and spaces separate several, pasted at once. What is
 * not an address comes back as typed, to say so.
 */
export function parseAddresses(text: string): { addresses: string[]; invalid: string[] } {
    const addresses: string[] = [];
    const invalid: string[] = [];
    for (const part of text.split(/[\s,;]+/)) {
        // "Pat Doe <pat@client.example>" pasted from a mail client: the address in the brackets.
        const raw = part.replace(/^<|>$/g, '');
        if (raw === '') continue;
        const address = normaliseEmail(raw);
        if (address) addresses.push(address);
        else invalid.push(part);
    }
    return { addresses, invalid };
}

export interface Draft {
    mailboxId: string;
    personId: string;
    dealId?: string | undefined;
    /** People added beside the record's person; the person is always the first recipient. */
    alsoTo: readonly string[];
    cc?: readonly CopyRecipient[] | undefined;
    bcc?: readonly CopyRecipient[] | undefined;
    /** The saved draft this message was written in: the API deletes it with the send. */
    draftId?: string | undefined;
    subject: RichText;
    body: RichText;
    fill: TemplateFill | null;
    replyToMessageId?: string | undefined;
    /**
     * This message's signature (#193) once the sender edits or removes it (`null`); left `undefined` while
     * it is the mailbox's as shown, which the API then applies itself.
     */
    signature?: RichText | null | undefined;
    sendAt?: Date | undefined;
    timeZone: string;
    /** Follow-ups queued behind it, in order; each goes in its thread as a reply, unless the person answers. */
    followUps?: readonly FollowUpDraft[] | undefined;
}

/**
 * A follow-up as the composer holds it: when it goes (in the sender's zone, as the picker reads it), and what it
 * says — an empty subject is the thread's (`Re: …`, the server's), a body is required.
 */
export interface FollowUpDraft {
    /** A stable key for the row; never sent. */
    key: string;
    sendAt: Date | null;
    subject: RichText;
    body: RichText;
}

/** How long after the one before a new follow-up row starts: three days, the usual nudge. */
const FOLLOW_UP_GAP_MS = 3 * 24 * 60 * 60 * 1000;

/** Where a new follow-up row starts: three days after the one before it (or after `from`, the first email). */
export function nextFollowUpAt(followUps: readonly FollowUpDraft[], from: number): Date {
    const last = followUps.at(-1)?.sendAt?.getTime() ?? from;
    return new Date(Math.max(last, from) + FOLLOW_UP_GAP_MS);
}

/** Whether another follow-up may be added. */
export const canAddFollowUp = (followUps: readonly FollowUpDraft[]) => followUps.length < MAIL_FOLLOW_UPS_MAX;

/**
 * Why the follow-ups cannot go as they are, in words — the first problem, naming the follow-up; null when they can.
 * Each needs a message and a time the API takes (`scheduleProblem`), later than the email before it (`first`: the
 * first email's time — now for a send now). The API checks the same again.
 */
export function followUpProblem(followUps: readonly FollowUpDraft[], first: number, now: number): string | null {
    let previous = first;
    for (const [index, f] of followUps.entries()) {
        const which = `Follow-up ${index + 1}`;
        if (isBlank(f.body)) return `${which}: write a message.`;
        const time = scheduleProblem(f.sendAt, now);
        if (time) return `${which}: ${time.charAt(0).toLowerCase()}${time.slice(1)}`;
        if (f.sendAt!.getTime() <= previous) return `${which}: pick a time after the email before it.`;
        previous = f.sendAt!.getTime();
    }
    return null;
}

const same = (a: RichText, b: RichText) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether the draft goes AS its template (`templateId`). The composer says so when it does not
 * ("edited — sends as written"), so an edit never changes what is sent without the person seeing it.
 */
export function sendsAsTemplate(draft: Pick<Draft, 'fill' | 'subject' | 'body' | 'replyToMessageId'>): boolean {
    return (
        draft.fill !== null &&
        draft.replyToMessageId === undefined &&
        same(draft.subject, draft.fill.subject) &&
        same(draft.body, draft.fill.body)
    );
}

/**
 * The request for a draft. A template left exactly as filled is sent AS the template
 * (`templateId`), so the send is attributed to it; once edited it is the written subject and body
 * (the API takes one or the other, never both). A reply is always written: with no subject of its
 * own it takes the parent's (`Re: …`) on the server, which a template's subject would replace.
 */
export function sendInput(draft: Draft): SendMailInput {
    const asTemplate = sendsAsTemplate(draft);
    const subject = docToSubject(draft.subject);
    return {
        mailboxId: draft.mailboxId,
        personId: draft.personId,
        ...(draft.dealId ? { dealId: draft.dealId } : {}),
        ...(draft.alsoTo.length
            ? { to: [{ personId: draft.personId }, ...draft.alsoTo.map((personId) => ({ personId }))] }
            : {}),
        ...(draft.cc?.length ? { cc: draft.cc.map(recipientInput) } : {}),
        ...(draft.bcc?.length ? { bcc: draft.bcc.map(recipientInput) } : {}),
        ...(draft.draftId ? { draftId: draft.draftId } : {}),
        ...(asTemplate && draft.fill
            ? { templateId: draft.fill.templateId }
            : { body: draft.body, ...(subject !== '' ? { subject } : {}) }),
        ...(draft.replyToMessageId ? { replyToMessageId: draft.replyToMessageId } : {}),
        ...(draft.signature !== undefined ? { signature: draft.signature } : {}),
        ...(draft.sendAt || draft.followUps?.length ? { timeZone: draft.timeZone } : {}),
        ...(draft.sendAt ? { sendAt: draft.sendAt.toISOString() } : {}),
        ...(draft.followUps?.length
            ? {
                  followUps: draft.followUps.map((f) => {
                      const subject = docToSubject(f.subject);
                      return {
                          sendAt: f.sendAt!.toISOString(),
                          body: f.body,
                          ...(subject !== '' ? { subject } : {}),
                      };
                  }),
              }
            : {}),
    };
}

/**
 * The variables a refused send named as empty (`422 unprocessable`, one field error per path) — a follow-up's
 * under its own `followUps.<n>.`, read as the variable it names.
 */
export function refusedVariables(error: unknown): string[] {
    if (!(error instanceof ApiError) || error.status !== 422 || error.code !== 'unprocessable') return [];
    return error.fieldErrors.map((f) => f.path.replace(/^followUps\.\d+\./, '')).filter((path) => path.includes('.'));
}

/** A copy recipient as the send names it: a person by id, an address as typed. */
function recipientInput(r: CopyRecipient): { personId: string } | { address: string } {
    return 'personId' in r ? { personId: r.personId } : { address: r.address };
}

/**
 * Everything the record composer holds — what a draft keeps, so reopening the composer puts it all back: the
 * mailbox, the people beside the record's person, cc and bcc, subject and body, the template it was filled from,
 * this message's own signature (left `undefined` while it is the mailbox's), the time picked to schedule it, and
 * the follow-ups queued behind it.
 */
export interface ComposerState {
    mailboxId: string;
    alsoTo: readonly { id: string; name: string }[];
    cc: readonly CopyRecipient[];
    bcc: readonly CopyRecipient[];
    subject: RichText;
    body: RichText;
    templateId: string | null;
    signature: RichText | null | undefined;
    sendAt: Date | null;
    followUps: readonly FollowUpDraft[];
}

/** Whether there is anything in the composer worth keeping as a draft. */
export function hasDraftContent(state: ComposerState): boolean {
    return (
        !isBlank(state.body) ||
        docToSubject(state.subject).trim() !== '' ||
        state.alsoTo.length > 0 ||
        state.cc.length > 0 ||
        state.bcc.length > 0 ||
        state.followUps.length > 0
    );
}

/** The composer's state as a draft keeps it (`MailDraftContent`): recipients as a send names them, with names. */
export function draftContent(personId: string, state: ComposerState, timeZone: string): MailDraftContent {
    const copy = (r: CopyRecipient) => ('personId' in r ? { personId: r.personId, name: r.name } : r);
    return {
        mailboxId: state.mailboxId || null,
        ...(state.alsoTo.length
            ? { to: [{ personId }, ...state.alsoTo.map((p) => ({ personId: p.id, name: p.name }))] }
            : {}),
        ...(state.cc.length ? { cc: state.cc.map(copy) } : {}),
        ...(state.bcc.length ? { bcc: state.bcc.map(copy) } : {}),
        ...(state.templateId ? { templateId: state.templateId } : {}),
        subject: docToSubject(state.subject),
        body: state.body,
        ...(state.signature !== undefined ? { signature: state.signature } : {}),
        ...(state.sendAt ? { sendAt: state.sendAt.toISOString() } : {}),
        timeZone,
        ...(state.followUps.length
            ? {
                  followUps: state.followUps.map((f) => ({
                      sendAt: f.sendAt?.toISOString() ?? null,
                      subject: docToSubject(f.subject),
                      body: f.body,
                  })),
              }
            : {}),
    };
}

/** A saved draft back into the composer's state: what `draftContent` kept, with an empty composer's defaults. */
export function stateFromDraft(personId: string, draft: Pick<MailDraftView, 'content'>): ComposerState {
    const c = draft.content;
    const copy = (r: NonNullable<MailDraftView['content']['cc']>[number]): CopyRecipient =>
        'personId' in r ? { personId: r.personId, name: r.name ?? 'Person' } : { address: r.address };
    return {
        mailboxId: c.mailboxId ?? '',
        alsoTo: (c.to ?? []).flatMap((r) =>
            'personId' in r && r.personId !== personId ? [{ id: r.personId, name: r.name ?? 'Person' }] : [],
        ),
        cc: (c.cc ?? []).map(copy),
        bcc: (c.bcc ?? []).map(copy),
        subject: c.subject ? subjectToDoc(c.subject) : EMPTY_DOC,
        body: (c.body as RichText | undefined) ?? EMPTY_DOC,
        templateId: c.templateId ?? null,
        signature: c.signature as RichText | null | undefined,
        sendAt: c.sendAt ? new Date(c.sendAt) : null,
        followUps: (c.followUps ?? []).map((f, index) => ({
            key: `follow-up-saved-${index}`,
            sendAt: f.sendAt ? new Date(f.sendAt) : null,
            subject: f.subject ? subjectToDoc(f.subject) : EMPTY_DOC,
            body: (f.body as RichText | undefined) ?? EMPTY_DOC,
        })),
    };
}
