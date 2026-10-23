import { MAIL_FOLLOW_UPS_MAX, SIGNATURE_PLACEMENT_VARIABLE, type RichText, type RichTextNode } from '@bylinecrm/shared';
import { ApiError } from '../../../api/client';
import type { MailboxView, SendMailInput } from '../../../api/types';
import { templateVariablePaths } from '../templates/preview';
import { docToSubject } from '../templates/subject';
import { scheduleProblem } from './schedule';

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

export interface Draft {
    mailboxId: string;
    personId: string;
    dealId?: string | undefined;
    /** People added beside the record's person; the person is always the first recipient. */
    alsoTo: readonly string[];
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
